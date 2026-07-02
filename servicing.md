# Servicing Events — Status

> The servicing-events feature shipped in **PR #1395**. The implementation lives
> in `src/shared/db/attendees/servicing.ts`, `src/features/admin/servicing.tsx`,
> `src/features/admin/servicing-form-model.ts`, `src/shared/accounting/`, and the
> `test/lib/servicing/` suite — those are the source of truth.
>
> This document tracked the known issues that remained after the merge. The P1
> and all four P2s below have since been **fixed** (each with a regression test,
> per AGENTS.md → "Every bug fix ships with a regression test"); they are kept
> here as a short changelog. The two holistic refactors are partly done — see
> their sections for what remains.

## Fixed

### P1 — Read-only mode is default-deny (was: servicing writes bypassed read-only)

`readOnlyGuard` in `src/features/index.ts` is now an **allowlist**: in read-only
mode every mutating method (`POST`/`PUT`/`PATCH`/`DELETE`) that doesn't match the
small `READ_ONLY_SAFE_PATHS` set redirects to `/read-only` (API mutations get a
JSON 403). The servicing write routes — and the other write routes the old
blocklist missed — are blocked by default; a newly added write route is guarded
the moment it exists. Asserted in `test/routes/read-only.test.ts`.

### P2 — Idempotent cost replay verifies the payload

`recordServiceCost` no longer short-circuits on a stored `reference` alone. It
returns the existing cost id **only** when the stored `service_costs` row matches
the operator-entered payload — amount, servicing event, listing, and the
decrypted memo. A reused idempotency key (or a payload-derived reference that
omits the memo) whose payload has since changed throws `COST_REPLAY_MISMATCH`,
which the route surfaces as a form error instead of a false success or a 500.
`occurredAt` is deliberately excluded from the match: it isn't an operator-
editable field (it's the booking date, or `new Date()` for a dateless event), so
comparing it would break a legitimate double-submit of a dateless cost — the
exact retry the key exists to cover.

### P2 — Free-text answers survive a failed servicing-edit rollback

`updateServicingEvent` now snapshots the pre-edit answers with
`{ texts: true, privateKey }` and rebuilds them into an `AttendeeAnswerSet`
carrying both choice ids and decrypted free-text answers, so
`restoreServicingState`'s compensation restores the whole answer set, not just
its choice half.

### P2 — Fractional minor-unit amounts are rejected, not rounded

Money parsing is now a shared, currency-aware valibot schema in
`src/shared/validation/money.ts` (`parsePositiveMinorUnits`) whose accepted
decimal places track `settings.currency` at parse time. `1.005` in GBP and
`1.23` in JPY are rejected rather than silently rounded. The service-cost routes
parse through it, and the ledger's amount parse was unified onto the same schema
(its duplicate currency-aware schema is gone). The browser side matches via the
shared `PriceInput` component (`src/ui/templates/components/price-input.tsx`),
whose `step` is derived from the currency and which now backs the servicing,
ledger, listing, modifier, and attendee-balance amount fields.

### P2 — Demo-mode overrides apply to servicing forms

The servicing create/edit POST handlers call
`applyDemoOverrides(form, SERVICING_DEMO_FIELDS)` (in the shared
`parseCreateInput`), so a demo instance replaces a submitted servicing name with
a demo servicing reason, mirroring the attendee form.

## Remaining holistic work

### Holistic 1 — Read-only default-deny (done)

The minimal inversion described in the original plan shipped (see the P1 entry).
The fuller registry-driven variant (resolve the route first, consult a per-route
`readOnly: "allow"` flag) remains an optional future refactor; the current
path-based allowlist already fails closed.

### Holistic 2 — One money schema (largely done)

`src/shared/validation/money.ts` houses the shared currency-aware family across
both axes — **bound** (positive / non-negative / signed) × **blank handling**
(required blank ⇒ `0`, optional blank ⇒ `null` — never a real `0`): plus a
currency-aware `validatePrice`. The migrated sites now reject a prefix, comma
group, or over-precise amount instead of `Number.parseFloat`-coercing/rounding:

- service costs + ledger entries (positive);
- listing `unit_price` + custom day prices (optional) and the non-negative price
  validator behind `unit_price` / `max_price`;
- public / QR prices (`validatePrice`);
- balance / income / modifier-revenue corrections (signed `money-adjust`);
- reservation `flat` / `perItem` amounts (currency-precise; percentages keep
  their precision).

The browser side matches via `PriceInput`'s `moneyStep()` and a shared
`moneyPattern()`, now used for `unit_price`, `max_price`, the QR override price,
and custom day prices (so KWD's 3 decimals are typeable and JPY isn't offered
cents).

**Remaining:** the modifier `calc_value` / `min_subtotal` fields. These are NOT
plain money fields — `calc_value` is polymorphic (a currency amount only when
`calc_kind === "fixed"`, otherwise a percentage or a bare multiplier) and is
stored in **major** units (converted at resolve time), and both use `parse`/
`validate` field callbacks. Making the fixed case currency-aware needs
cross-field (calc_kind-aware) validation rather than the single-field swap the
other sites took, so it's left as a separate, self-contained change.
