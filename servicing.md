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
the stored leg matches the **whole** submitted payload — amount, listing,
`occurred_at`, `servicing_attendee_id`, **and the memo**. The cost form also
submits `memo`, and the first request's encrypted memo is what gets stored in
both `transfers` and `service_costs`; a replay check that compares only
amount/listing/date/servicing would still report success while silently
preserving the old memo when an operator reuses the key and changes only the
memo. On any mismatch, return a form error rather than a false success.
Regression tests: post the same idempotency key twice with (a) a changed amount
and (b) a changed memo only, and assert the second submit either errors or
records the change — never silently succeeds while storing nothing/the stale
value.

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
`READ_ONLY_SAFE` allowlist for the genuinely-safe exceptions. A newly added
write route is then blocked the moment it exists; the only way to fail is to
*forget to allowlist a safe route*, which fails **closed** (an over-blocked safe
route is a visible, harmless nuisance, not a silent data-mutation hole).

**The allowlist is broad and must be derived from the registry, not hand-listed
here.** Read-only mode is the state a *lapsed* site sits in, so a surprising
number of mutating routes must stay reachable — not just auth. The categories
below are the ones found so far, but treat this as **illustrative, not
authoritative**: the implementer must audit *every* mutating route in the
registry and classify it keep-safe vs block, because an under-built allowlist
fails closed in a user-visible way (a real, safe action starts redirecting to
`/read-only`). The repeated "you missed one" findings on this very list are the
point — a hand-maintained enumeration is the brittleness being fixed, which is
itself the argument for the registry-driven tier below (a per-route
`readOnly: "allow"` flag co-located with the route can't drift out of sync).

Safe-set categories found so far (each needs an allowlist entry **and** a
read-only test asserting it still reaches its handler / returns its protocol
status, in the same change that flips the guard):

- **Auth** — `POST /admin/login`, `POST /admin/logout`.
- **Billing / lifecycle** — `POST /renew` (`handleRenewalPost`) and
  `POST /payment/webhook` (`handlePaymentWebhook`, `src/features/api/webhooks.ts`,
  unauthenticated). These are how an operator *leaves* read-only mode; blocking
  them is a permanent lockout.
- **Wallet protocol callbacks** — `POST /v1/devices/:device/registrations/...`,
  `DELETE /v1/devices/:device/registrations/...`, and `POST /v1/log`
  (`src/features/wallet/webservice.ts`). Apple Wallet device clients call these
  and expect 200/201 protocol responses; a 302 to `/read-only` breaks pass
  add/remove on a read-only site.
- **Public / owner messaging** — `POST /contact` (public contact form via
  `contactPrefixHandler` → `handlePublicContactSubmit`), `POST /admin/support`
  (owner-only support channel — the in-app path most likely to *resolve* a
  read-only/billing problem, so blocking it is self-defeating), and
  `POST /unsubscribe` (`handleUnsubscribePost`, public/no-login marketing
  preference + contact-deletion). Each is currently reachable under read-only
  mode, so the allowlist must preserve that behaviour.

**Two implementation tiers, smallest blast radius first:**

1. *Minimal inversion (recommended first step).* Replace
   `READ_ONLY_POST_PATTERNS` with the `READ_ONLY_SAFE` allowlist and flip the
   match: in read-only mode any **mutating-method** request (POST/PUT/PATCH/**and
   DELETE**) that does **not** match the safe list redirects to `/read-only`.
   The method set must include DELETE — the registry has real DELETE mutations
   (`DELETE /admin/listing/:id/delete`,
   `DELETE /admin/listing/:listingId/attendee/:attendeeId/delete`) that a
   POST-only flip would leave writable. Keep the existing pre-routing, path-based
   structure — only the polarity and the method set change. This instantly closes
   servicing **and** the other latent gaps above. The GET-form list
   (`READ_ONLY_GET_PATTERNS`) stays a blocklist: it is cosmetic (a writable form
   rendered read-only is harmless because its mutating POST/DELETE is now
   blocked), so it doesn't need inverting. **Preserve the existing API branch:**
   the guard already returns a JSON `403` (`{ error: READ_ONLY_MESSAGE }`) for
   `/api/*` mutations rather than an HTML redirect (`src/features/index.ts`
   ~`:511`, asserted by `test/routes/read-only.test.ts`). The default-deny path
   must keep that content-type/prefix split so API consumers still get a JSON
   403, not a 302 page — block by default, but respond in the caller's format.

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

- **A small bound-parameterised family sharing one currency-aware decimal
  pattern, not a single schema.** Money in this app spans three bounds, so a lone
  positive `minValue(1)` parser is wrong for most sites. The axes are
  **bound** (positive / non-negative / signed) *and* **blank handling**
  (required vs optional) — and crucially blank ≠ zero for the optional fields:
  - *Strictly positive* (`minValue(1)`) — service costs, and amounts that must be
    non-zero.
  - *Non-negative, required* (`minValue(0)`, blank ⇒ `0`) — fields where an
    explicit zero is a real value: listing `unit_price` defaults to `0` for free
    listings (`src/shared/db/listings.ts:213`) and modifier `min_subtotal`
    defaults to `0` (`src/shared/db/modifiers.ts:73`). A `minValue(1)` schema
    would reject free tickets and zero-threshold modifiers.
  - *Optional override* (non-negative when present, blank ⇒ **unset, not `0`**) —
    fields that distinguish "no value" from "zero". The QR price override only
    sets `valueMinor` when the input is non-empty and `buildQrBookPayload` stores
    a `v: -1` sentinel for "no override" (`src/features/admin/listing-qr.ts:149`),
    and `parseDayPricesFromForm` **skips** blank `day_price_N` rows so that
    duration isn't offered (`src/features/admin/listings-form.ts:57`). A parser
    that coerces blank ⇒ `0` would turn a blank fixed-price QR into a signed
    free-ticket override and a skipped day-price into a real £0 price. These must
    parse to `null`/skip on blank, validating the value with the non-negative
    rule only when present.
  - *Signed* (negatives + zero) — the owner-correction targets in
    `src/features/admin/money-adjust.ts`, because a modifier's net revenue can
    legitimately be negative.

  Build all four from one `ledgerAmountPattern` decimal check (the signed
  variant allows a leading `-`), e.g. a `moneyMinorSchema({ min })` core plus
  named `parsePositiveMinorUnits` / `parseNonNegativeMinorUnits` (required) /
  `parseOptionalMinorUnits` (blank ⇒ `null`) / `parseMoneyMinor` (signed)
  wrappers. Pick the variant per call site; the decimal/format validation is
  shared, only the bound and blank-handling differ. **Do not collapse "unset"
  into a real zero** — that is its own regression class.
- Because decimal places depend on `settings.currency` at parse time, the
  pattern must be built **per parse** (as `ledgerAmountPattern` does), not frozen
  as a module constant.
- Migrate **every** money call site onto the matching variant, and delete the
  ad-hoc `toMinorUnits(Number.parseFloat(...))` / unrestricted-regex parses.
  Don't stop at the always-money fields — include the **conditionally-money**
  ones, or `12.34abc` / `1.005` inputs still slip through after the validator
  lands:
  - modifier `calc_value`, which is `Number.parseFloat`-parsed and
    `toMinorUnits`-converted only when `calc_kind === "fixed"`
    (`src/ui/templates/fields.ts` ~`:891`, `src/shared/db/modifier-resolve.ts`
    ~`:40`);
  - reservation amounts (flat / per-item), which accept an unrestricted decimal
    regex before `toMinorUnits` (`src/shared/reservation-amount.ts` ~`:30`,
    ~`:71`).
- **Fix the browser input metadata too, or valid amounts can't be typed.** Two
  flavours of hard-coded two-decimal metadata both reject a valid 3-decimal
  amount (KWD `1.005`) via native validation before the parser runs, and
  mis-advertise cents on a zero-decimal currency (JPY):
  - `step="0.01"` on number inputs across five templates (`servicing.tsx`,
    `ui/templates/admin/ledger.tsx`, `listings.tsx`, `modifiers.tsx`,
    `attendee-form.tsx`);
  - hard-coded `pattern="\d+(\.\d{1,2})?"` on text inputs — the QR override price
    (`src/ui/templates/admin/listing-qr.tsx:77`) and custom day prices
    (`src/ui/templates/admin/listings.tsx:1440`).

  Derive `step`, `pattern`/`title`, and `min` (per the positive / non-negative /
  signed bound) from `getDecimalPlaces(settings.currency)` in the same refactor,
  so each control accepts exactly what its shared schema does.

This fixes the service-cost fractional bug **and** the `validatePrice` prefix bug
in one place, keeps the zero-valued, optional-override, and signed forms working,
and stops the next money field from re-introducing any of these. Pair it with
table-driven tests over `{1.005 GBP, 1.23 JPY, "1,000", "12.34abc", "  10.50  ",
negative, zero, blank}` against each variant — positive rejects
negative/zero/blank; non-negative-required accepts zero, blank ⇒ `0`, rejects
negative; **optional accepts the same values but blank ⇒ `null` (never `0`)**;
signed accepts all finite — so the invariants are locked across currencies,
bounds, and blank-handling.
