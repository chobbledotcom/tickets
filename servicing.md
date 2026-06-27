# Servicing Events — Follow-up Fixes

> The servicing-events feature shipped in **PR #1395**. The implementation in
> `src/shared/db/attendees/servicing.ts`, `src/features/admin/servicing.tsx`,
> `src/features/admin/servicing-form-model.ts`, `src/shared/accounting/`, and the
> `test/lib/servicing/` suite is the source of truth. The original planning doc
> has been retired; this document now tracks the **known issues that still need
> fixing** after the merge, plus two holistic refactors that would close whole
> classes of these bugs rather than patching them one route at a time.
>
> Every fix below ships with a regression test that fails before the fix and
> passes after it (see AGENTS.md → "Every bug fix ships with a regression test").
> Each item names the exact reproduction so the test exercises the real defect,
> not just the changed lines.

Status as of 2026-06-27 (verified against the merged code, not the review
threads — several earlier review comments are already addressed in the shipped
code and are **not** listed here, e.g. the cost-ownership guard
`costBelongsToServicing` is already called by the cost-edit route).

---

## P1 — Servicing writes bypass read-only mode

**Symptom.** On a site past `READ_ONLY_FROM`, POSTs to create, update, delete,
duplicate, record-cost, and edit-cost for service events still reach their
handlers and mutate `attendees` / `service_costs` / `transfers`, while every
comparable admin write path redirects to `/read-only`.

**Root cause.** The guard `readOnlyGuard` in `src/features/index.ts` matches the
request path against a **hand-maintained regex blocklist**
(`READ_ONLY_POST_PATTERNS`, and `READ_ONLY_GET_PATTERNS` for the create/edit
forms). The servicing routes — added later — were never appended to either list,
so they default to writable. This is the failure mode of any blocklist: a new
write route is unguarded until someone remembers to add it.

**Locations.**
- `src/features/index.ts` — `READ_ONLY_POST_PATTERNS`, `READ_ONLY_GET_PATTERNS`,
  `readOnlyGuard`.
- `src/features/admin/servicing.tsx` — `servicingRoutes` (the 5 POST routes:
  `/admin/servicing/new`, `/admin/servicing/:id`,
  `/admin/servicing/:id/cost/:costId`, `/admin/servicing/:id/delete`,
  `/admin/servicing/:id/duplicate`) and the 2 form GETs
  (`/admin/servicing/new`, `/admin/servicing/:id`).

**Narrow fix.** Add the `/admin/servicing…` POST patterns to
`READ_ONLY_POST_PATTERNS` and the create/edit form GET patterns to
`READ_ONLY_GET_PATTERNS`, then assert in `test/routes/read-only.test.ts` that
each redirects to `/read-only` and posts **no** ledger leg / attendee row.

**Holistic fix.** See *Holistic 1 — read-only as default-deny*. The blocklist is
already systematically incomplete (servicing is not the only unguarded write
route), so the durable fix inverts it to an allowlist.

---

## P2 — Idempotent cost replay ignores a changed payload

**Symptom.** When an already-used `cost_idempotency_key` is posted again with a
**different** amount, listing, or date (e.g. a bfcached/stale cost form the
operator edits before resubmitting), the route reports success for the new
values but records nothing — and it bypasses the ledger conflict that
`postTransfersTx` would otherwise raise.

**Root cause.** `recordServiceCost` short-circuits on
`SELECT id FROM transfers WHERE reference = ?` and returns the existing transfer
id **without checking that the stored leg matches the new request**. When the
route supplies the client `cost_idempotency_key` as `reference`, that reference
is an opaque per-render token, not derived from the payload — so a different
payload under the same key resolves to the old leg and is treated as a no-op
replay.

**Locations.**
- `src/shared/db/attendees/servicing.ts` — `recordServiceCost` (the
  pre-transaction `WHERE reference = ?` short-circuit) and `serviceCostTransfer`
  (where `reference = input.reference ?? legReference([...payload])`).
- `src/features/admin/servicing.tsx` — `handleCostPost` (passes
  `reference: form.getString("cost_idempotency_key") || undefined`).

**Fix.** Treat a reference hit as an idempotent replay **only after** verifying
the stored leg's amount + listing (and `service_costs` row's `occurred_at` /
`servicing_attendee_id`) match the submitted payload. On a mismatch, return a
form error rather than a false success. Regression test: post the same
idempotency key twice with a changed amount and assert the second submit either
errors or records the change — never silently succeeds while storing nothing.

---

## P2 — Free-text custom answers lost on a failed servicing edit rollback

**Symptom.** If a servicing edit commits the booking/name change and then the
answer save partially fails, the compensation restores the event's name,
bookings, and **choice** answers — but drops any prior **free-text** custom
answers, even though the edit is reported as rolled back.

**Root cause.** `updateServicingEvent` snapshots the pre-edit answers with
`getAttendeeAnswersBatch([id], { texts: false })`, which returns only choice
answer ids (`WHERE answer_id IS NOT NULL` excludes free-text rows). The
compensation `restoreServicingState` re-saves that partial snapshot, so the
free-text answers `saveAttendeeAnswers` already deleted are not restored.

**Locations.**
- `src/shared/db/attendees/servicing.ts` — `updateServicingEvent` (the
  `{ texts: false }` snapshot) and `restoreServicingState`.
- `src/shared/db/questions.ts` — `getAttendeeAnswersBatch` overloads
  (`{ texts: true, privateKey }` returns choice + decrypted text answers).

**Fix.** Capture the full pre-edit snapshot including decrypted texts
(`{ texts: true, privateKey }`) and restore both choice and text answers in the
compensation — or make the answer replacement itself atomic so no rollback of
the answer set is needed. Regression test: a servicing event with a free-text
answer whose edit's answer-save is forced to fail must come back with the
free-text answer intact.

---

## P2 — Fractional minor-unit cost amounts are silently rounded

**Symptom.** A crafted or mistyped service-cost amount carrying more decimal
places than the currency allows is rounded instead of rejected: `1.005` in GBP
becomes `101` pence; `1.23` in a zero-decimal currency (JPY) becomes `1` minor
unit. The recorded cost/profit differs from what was submitted.

**Root cause.** `parsePositiveMinorUnits` validates with a currency-agnostic
regex `/^\d+(\.\d+)?$/` (any number of decimals) and then `toMinorUnits` rounds.
The ledger already solved this with a **currency-decimal-aware** pattern
(`ledgerAmountPattern` builds `^\d+(?:\.\d{1,<places>})?$` from
`getDecimalPlaces(settings.currency)`), but the service-cost path doesn't reuse
it.

**Locations.**
- `src/shared/currency.ts` — `parsePositiveMinorUnits` (loose regex) and
  `validatePrice` (which still uses prefix-accepting `Number.parseFloat`).
- `src/features/admin/ledger.ts` — `ledgerAmountPattern` / `ledgerAmountSchema`
  (the correct, currency-aware reference implementation).

**Fix.** Reject amounts with more decimal places than the currency allows.
Holistic fix: see *Holistic 2 — one money schema* — converge service costs,
prices, and the ledger onto a single currency-aware validator so this can't be
re-introduced per money field.

---

## P2 — Demo-mode overrides not applied to servicing forms

**Symptom.** On a demo instance, creating or editing a service event stores the
operator's arbitrary submitted name text and shows it on the servicing
list/dashboard, instead of replacing it with a demo servicing reason — unlike
the attendee form, which swaps PII for demo values.

**Root cause.** The servicing create/edit POST handlers call
`parseCreateInput(form)` directly and never call
`applyDemoOverrides(form, SERVICING_DEMO_FIELDS)`. The `SERVICING_DEMO_FIELDS`
map exists but is unused; the attendee form applies its equivalent
(`ATTENDEE_DEMO_FIELDS`) in `handleSubmitInner` before parsing.

**Locations.**
- `src/features/admin/servicing.tsx` — `handleServicingNewPost`,
  `handleServicingPost`.
- `src/shared/demo.ts` — `SERVICING_DEMO_FIELDS`, `applyDemoOverrides`.
- `src/features/admin/attendee-form-routes.ts` — `handleSubmitInner` (the
  parallel `applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS)` call to mirror).

**Fix.** Call `applyDemoOverrides(form, SERVICING_DEMO_FIELDS)` before
`parseCreateInput` in both POST handlers. Regression test: in demo mode, a
submitted servicing name is replaced by a demo reason on save.

---

## Holistic 1 — Read-only mode as default-deny (allowlist), not a blocklist

The P1 bug is not a one-off omission. Routing in this app is a **central
registry**: every route is declared as `"<METHOD> /path": handler` via
`defineRoutes` and merged into one admin router (`src/features/admin/index.ts`).
Against that, `readOnlyGuard` maintains a *parallel, partial* regex blocklist —
so the read-only contract is only as complete as someone's memory. A quick audit
of the registry against `READ_ONLY_POST_PATTERNS` shows servicing is **not the
only** gap: listing delete, attendee delete/refund, attendee notes, modifier
edit, group edit, and group bulk-actions all currently slip through read-only
mode too. The blocklist fails **open**.

**Inversion.** In read-only mode, block every mutating method
(`POST`/`PUT`/`DELETE`/`PATCH`) by default and keep a small explicit
`READ_ONLY_SAFE_POST` allowlist for the genuinely-safe exceptions (auth:
`/admin/login`, `/admin/logout`). A newly added write route is then blocked the
moment it exists; the only way to fail is to *forget to allowlist a safe POST*,
which fails **closed** (an over-blocked safe route is a visible, harmless
nuisance, not a silent data-mutation hole).

**Two implementation tiers, smallest blast radius first:**

1. *Minimal inversion (recommended first step).* Replace
   `READ_ONLY_POST_PATTERNS` with `READ_ONLY_SAFE_POST` and flip the match: in
   read-only mode a POST that does **not** match the safe list redirects to
   `/read-only`. Keep the existing pre-routing, path-based structure — only the
   polarity changes. This instantly closes servicing **and** the other latent
   gaps above. The GET-form list (`READ_ONLY_GET_PATTERNS`) stays a blocklist:
   it is cosmetic (a writable form rendered read-only is harmless because its
   POST is now blocked), so it doesn't need inverting.

2. *Registry-driven (fuller refactor).* Resolve the route first, then consult the
   matched route definition's method rather than regex-matching the path —
   eliminating the parallel list entirely. A per-route opt-in flag
   (e.g. `readOnly: "allow"` on the auth routes) documents the exception at the
   declaration site. This requires moving the guard to run after route
   resolution but before handler invocation; weigh that against the minimal
   inversion, which needs no routing changes.

Either way the principle is the same: **the safe set is small and known; the
mutating set is large and grows — guard the small one.**

---

## Holistic 2 — One currency/money validation schema

The fractional-minor-unit bug exists because money parsing is **scattered and
inconsistent**:

| Site | Parser | Currency-aware? |
| --- | --- | --- |
| Service costs (`parsePositiveMinorUnits`) | regex `^\d+(\.\d+)?$` → `toMinorUnits` | ❌ rounds extra decimals |
| Public/QR prices (`validatePrice`) | `Number.parseFloat` → `toMinorUnits` | ❌ accepts prefixes |
| Listing prices / modifier min-subtotal / balance adjust | ad-hoc `toMinorUnits(Number.parseFloat(raw))` | ❌ |
| Ledger entries (`ledgerAmountSchema`) | valibot, `ledgerAmountPattern` per currency | ✅ correct |

Only the ledger schema is correct, and it already demonstrates the right shape:
a valibot `v.pipe` that checks a **currency-decimal-aware** pattern, coerces,
asserts finite + safe-integer + `minValue(1)`.

**Refactor.** Lift it into `src/shared/validation/money.ts` (mirroring the
existing `validation/number.ts`, `validation/email.ts`, `validation/date.ts`
modules and their `parseXxx` → null-on-invalid / `isValidXxx` convention):

- A canonical positive-money parser (`parsePositiveMinorUnits`) and a
  range-checked variant to replace `validatePrice`, both built on one
  currency-aware schema.
- Because decimal places depend on `settings.currency` at parse time, the
  pattern must be built **per parse** (as `ledgerAmountPattern` does), not frozen
  as a module constant.
- Migrate every money call site (service costs, prices, QR overrides, modifier
  subtotal, manual balance/ledger adjustments) onto it, and delete the ad-hoc
  `toMinorUnits(Number.parseFloat(...))` parses.

This fixes the service-cost fractional bug **and** the `validatePrice` prefix bug
in one place, and stops the next money field from re-introducing either. Pair it
with table-driven tests over `{1.005 GBP, 1.23 JPY, "1,000", "12.34abc",
"  10.50  ", negative, zero}` so the invariant is locked across currencies.
