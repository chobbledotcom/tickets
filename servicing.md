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

### Holistic 2 — One money schema (servicing slice + ledger done; broader migration remaining)

`src/shared/validation/money.ts` now houses the shared currency-aware positive
parser, and both the service-cost routes and the ledger use it. The remaining
work is to migrate the **other** money call sites onto the shared family and
delete their ad-hoc `toMinorUnits(Number.parseFloat(...))` / unrestricted-regex
parses — and to add the non-negative / optional-override / signed variants those
sites need (see the axes below). Until then, those fields keep their old parsing:

- `validatePrice` (public/QR prices) — still `Number.parseFloat`, accepts prefixes.
- listing `unit_price`, modifier `min_subtotal` / `calc_value`, balance-adjust,
  reservation amounts (flat/per-item), the QR price override, and custom day
  prices — ad-hoc parses.

The bound axes for the full family are **bound** (positive / non-negative /
signed) × **blank handling** (required vs optional, where blank ≠ zero for the
optional-override fields). Build them from one `ledgerAmountPattern`-style
decimal check; do **not** collapse "unset" into a real zero. The browser-side
`PriceInput` already derives `step` from the currency for every site that adopts
it; the two hard-coded `pattern="\d+(\.\d{1,2})?"` inputs (QR override price,
custom day prices) still need the same treatment.
