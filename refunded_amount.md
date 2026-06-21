# Plan: per-item `refunded_amount` + a partial-refund flow

Track **how much money was refunded for each item in an order**, and let the
operator refund either the whole order or specific amounts per item.

This is v2 of the plan, rewritten after owner decisions (2026-06-21). Those
decisions simplified it a lot — see "What changed & why it's simpler" at the end.

---

## 0. Decisions (locked)

1. **Column:** add `refunded_amount` (minor units) **per booking line**, on
   `listing_attendees` — next to `price_paid`. One amount per item in the order.
2. **Remove the `refunded` boolean** from `listing_attendees`. Refund *state*
   (e.g. "Refunded", "Partially refunded") is expressed with the existing
   **order statuses** (`attendee_statuses` / `attendees.status_id`); money is
   expressed with `refunded_amount`. The yes/no flag goes away entirely.
3. **No backfill, no provenance marker.** There are no existing refunds, so every
   recorded amount is exact by definition. Nothing to migrate or label.
4. **Refund flow is operator-driven and per-item.** A refund form with a "refund
   everything" checkbox (checked by default); unchecking reveals one row per
   listing in the order (label + price paid) with an amount input, `0` →
   `price paid`. We refund the chosen total at the provider and store each
   item's amount.
5. **Provider gains partial refunds.** `refundPayment` takes an optional
   `amount`; we pass the operator's total in. It keeps returning a boolean
   (success/failure) — we are *commanding* the refund, not reading it back.

One thing still needs a yes/no from you — **check-in behaviour** (§12). Everything
else is specified.

---

## 1. Data model

`listing_attendees` is the per-(attendee, listing) booking line. One attendee/order
can have several lines. Money already lives here:

| Column | Type | Meaning |
| --- | --- | --- |
| `price_paid` | `INTEGER` minor units | what was paid for this line (ticket only — excludes booking fees, which are a separate checkout `extras` line) |
| ~~`refunded`~~ | ~~`INTEGER` 0/1~~ | **removed** — refund state now lives in the order status |
| `refunded_amount` | `INTEGER` minor units, `NOT NULL DEFAULT 0` | **new** — how much of this line has been refunded (`0` ≤ amount ≤ `price_paid`) |

The provider payment reference stays where it is — in the **encrypted**
`attendees.pii_blob` (`payment_id`), one per order — so refunds are issued
against the order's payment.

The flattened `Attendee` type (a join of one `attendees` row + one
`listing_attendees` row) loses `refunded` and gains `refunded_amount: number`.

---

## 2. The refund flow (the centrepiece)

### 2a. The form — `GET /admin/listing/:listingId/attendee/:attendeeId/refund`

Replaces today's "are you sure?" confirm page (`adminRefundAttendeePage` in
`src/ui/templates/admin/attendees.tsx`). It shows:

- A **"Refund the whole order"** checkbox, **checked by default**. Checked = today's
  behaviour (refund everything still owed across the order).
- When **unchecked** (pure-CSS reveal, like the existing `show_all` pattern in the
  attendee form), a row per booking line in the order:
  - listing name (label),
  - "Paid: £X.XX" (the line's `price_paid`),
  - an amount input, `min=0`, `max=` the line's **remaining refundable**
    (`price_paid − refunded_amount`; `= price_paid` on a first refund), prefilled
    with that max.
- Confirm field (the existing name/identifier confirmation) + submit.

Optionally, a status selector defaulting to a "Refunded" order status when one
exists, so the operator marks state and money in one step. Nice-to-have; the
operator can also change status on the normal edit form.

### 2b. Submit — `POST .../refund`

`src/features/admin/attendee-refunds.ts`:

1. Parse the form. If "whole order" is checked, the per-item amounts are each
   line's remaining refundable; otherwise use the entered amounts (clamp each to
   `0 … remaining refundable`, integers, minor units).
2. `total = sum(per-item amounts)`. If `total === 0`, reject ("nothing to refund").
3. Require a `payment_id` (the order's payment). `provider.refundPayment(payment_id,
   total)` — **partial refund of `total`** (§3).
4. On success, for each line with a non-zero amount, add it to that line's
   `refunded_amount` (capped at `price_paid`), keyed to the exact row (§5). Log
   the activity (per line or once for the order).
5. On failure, redirect with an error; record nothing.

"Refund everything" therefore = each line refunded to its `price_paid`; a partial
refund = the operator's per-line numbers.

### 2c. Bulk — `POST /admin/listing/:id/refund-all`

Keep it; it refunds every **not-fully-refunded** line of every order on the
listing to its `price_paid` (full refund per attendee), batched as today
(`REFUND_BATCH_LIMIT`). "Refundable" is redefined in §6.

---

## 3. Provider layer — add partial refunds (small change)

We are *telling* the provider what to refund, so the only change is an **optional
amount**; the return stays a boolean. No return-shape churn, no reading amounts
back, no caller sweep.

- `PaymentProvider.refundPayment(ref: string, amount?: number): Promise<boolean>`
  — `amount` omitted = full refund (today's behaviour, so existing callers like
  the webhook auto-refund are untouched).
- **Stripe** (`src/shared/stripe.ts`): `s.refunds.create({ payment_intent: ref,
  amount })` — `amount` is the partial-refund field; omit for full.
- **Square** (`src/shared/square.ts`): pass the chosen `amount` as
  `amountMoney.amount` instead of the full payment amount it currently reads.
- **SumUp** (`src/shared/sumup-provider.ts`): confirm partial-refund support;
  if it is full-only, disable the per-item option for SumUp sites (offer only
  "refund everything") rather than silently over-refunding.

`isPaymentRefunded` is unchanged (still boolean) — see the refresh path (§8c).

---

## 4. Schema & migration

### 4a. Declarative schema — `src/shared/db/migrations/schema.ts`

In the `listing_attendees` table: **delete** the `["refunded", …]` column and
**add** `["refunded_amount", "INTEGER NOT NULL DEFAULT 0"]` next to `price_paid`.
Update `LATEST_UPDATE` to describe both. (`SCHEMA_HASH` recomputes automatically.)

No trigger change: the `LISTING_AGGREGATE_TRIGGERS` UPDATE trigger fires
`AFTER UPDATE OF quantity, price_paid, listing_id` — it never referenced
`refunded` and won't reference `refunded_amount`, so refunds still don't disturb
`listings.income`/capacity (income keeps counting refunded rows, exactly as
today).

### 4b. Migration — recreate the table

Removing a column needs a table rebuild, not `ADD COLUMN`. Model it on
`2026-06-18_answer_modifiers.ts` / `2026-06-20_free_text_questions.ts`:

```ts
// src/shared/db/migrations/2026-06-21_attendee_refunded_amount.ts
export default (context) =>
  context.additive({
    id: "2026-06-21_attendee_refunded_amount",
    description:
      "Add per-line refunded_amount to listing_attendees and drop the refunded boolean (refund state moves to order statuses)",
    requires: { columns: { listing_attendees: ["refunded_amount"] } },
    up: async () => {
      // recreateTable rebuilds listing_attendees from the *current* SCHEMA:
      // it copies surviving columns (so `refunded` is dropped, its data
      // discarded — there are no refunds), adds refunded_amount (DEFAULT 0),
      // and re-creates the table's indexes + aggregate triggers.
      await context.recreateTable("listing_attendees");
      await context.syncTriggers();
    },
  });
```

Register it in `src/shared/db/migrations.ts` (import + append to `MIGRATIONS`).
The generated `verify()` asserts `refunded_amount` is present; the recreate
guarantees `refunded` is gone (the helper has no "assert column absent", which is
fine — the rebuild is authoritative).

Backups round-trip the new shape automatically (schema-driven dump).

---

## 5. Write path — `src/shared/db/attendees/update.ts`

Replace `markRefunded` (which set the boolean) with a per-item amount writer that
targets **one** row by its real identity `(listing_id, attendee_id, start_at)` —
the table's unique key. Filtering by `(attendee_id, listing_id)` alone is wrong:
an attendee can book the same listing on several dates, so it would hit every
dated row and double-count.

```ts
/** Record a refund of `amount` (minor units) against one booking line. Adds to
 *  any existing refunded_amount, capped at the line's price_paid. */
export const recordLineRefund = async (
  attendeeId: number,
  listingId: number,
  startAt: string | null,
  amount: number,
): Promise<void> => {
  await execute(
    `UPDATE listing_attendees
        SET refunded_amount = MIN(price_paid, refunded_amount + ?)
      WHERE attendee_id = ? AND listing_id = ? AND start_at IS ?`,
    [amount, attendeeId, listingId, startAt],
  );
};
```

- `MIN(price_paid, …)` enforces the per-line cap in SQL.
- `start_at IS ?` matches the NULL (standard-listing) case as well as a date.
- For "refund everything", the route passes `price_paid − refunded_amount` per
  line (or call a small `refundLineInFull` that sets `refunded_amount =
  price_paid`).

---

## 6. Removing the boolean — the refactor surface

`refunded` is referenced in ~60 files; this is the bulk of the work. Each read of
the boolean becomes either a `refunded_amount`-derived check or an order-status
check. Concretely:

- **Types** — `src/shared/types.ts` (`Attendee`), `src/shared/db/attendee-types.ts`
  (`ListingAttendeeRow`): drop `refunded`, add `refunded_amount: number`.
- **Selects** — every per-line column list adds `refunded_amount` and drops
  `refunded`:
  - `src/shared/db/attendees/queries.ts` — `EA_COLS`, `ATTENDEE_LEFT_JOIN_SELECT`
    (`COALESCE(ea.refunded_amount,0)`), `getAttendeesByTokens`.
  - `src/features/admin/attendees-edit.ts` — `loadRefreshContext`.
  - `src/features/admin/attendees-merge.ts` — `loadAttendeeBookings`.
  - `src/shared/db/attendees/atomic-update.ts` — `loadExistingLines`.
  - Re-run `rg "ea\.refunded|checked_in, refunded, price_paid"` to confirm.
- **Decryption** — `src/shared/db/attendees/pii.ts` `decryptAttendeeFields`: map
  `refunded_amount: paidListing ? Number(row.refunded_amount ?? 0) : 0`; remove
  the `refunded` mapping.
- **"Refundable" predicate** — `attendee-refunds.ts` `getRefundable`: was
  `payment_id !== "" && !refunded`; becomes `payment_id !== "" && hasUnrefunded`,
  where a line/order is "unrefunded" if any line has `refunded_amount < price_paid`.
- **Check-in** — `src/features/checkin.ts:101` filters `!attendee.refunded`, and
  the scanner (`src/features/admin/scanner.ts`, `scanner.tsx`, client
  `scanner.js`, `manual-checkin.ts`) shows a refunded badge / blocks refunded
  tickets. These must move off the boolean — **see §12 for the behaviour decision.**
- **Merge** — `src/shared/merge/attendee-merge.ts`: `bookingInsertStatement` copies
  `refunded_amount` (and no longer `refunded`); the duplicate-detection compare in
  `buildBookingDiffItems` swaps `refunded` for `refunded_amount`.
- **Form model** — `src/features/admin/attendee-form-model.ts`: `AttendeeBooking`
  drops `refunded`, adds `refundedAmount`; `attendeeBookingsFromLines` sets it.
- **Templates** — `attendees.tsx` (`PaymentDetails`, the refund pages),
  `attendee-detail.tsx`, `attendee-form.tsx`, `attendee-table.tsx`,
  `scanner.tsx`: the "Refunded" badge derives from `refunded_amount` now (e.g.
  "Refunded £X" when `> 0`, "Partially refunded" when `0 < amount < price_paid`).
- **Webhooks** — `src/features/api/webhooks.ts`: the auto-refund of invalid
  checkouts still calls `provider.refundPayment(ref)` (no amount = full) and reads
  a boolean — **unchanged** (no row exists to record against). `webhook-types.ts`
  /`webhook.ts` outbound payload: drop `refunded` if present; optionally add
  `refunded_amount` (§14).

---

## 7. UI / display

### 7a. The refund form (§2a) — `attendees.tsx`

The new checkbox + per-item table. Build the per-item rows from the order's
booking lines (listing name + `price_paid` + remaining refundable). The reveal is
pure-CSS off the checkbox (no JS required), mirroring the existing `show_all`
pattern in the attendee editor.

### 7b. Payment details panel — `PaymentDetails` in `attendees.tsx`

Show the **order total refunded** = **sum** of `refunded_amount` across the
attendee's lines (not a single flattened join row — `getAttendeeRaw` returns one
row). Render per-line amounts in the bookings table (§7c) for the breakdown.

### 7c. Bookings table — `attendee-form.tsx` (+ `attendee-form-model.ts`)

Each booking row shows its `refundedAmount` alongside quantity/dates, so a
partially-refunded order is legible line by line.

### 7d. List + scanner badges

`attendee-columns.ts` status column and the scanner badge derive the
refunded label from `refunded_amount` (none / partial / full) instead of the
boolean.

---

## 8. Refresh-from-provider path (external refunds)

`src/features/admin/attendees-edit.ts` `handleRefreshPayment` polls
`isPaymentRefunded(payment_id)` (boolean) and, today, flips `refunded`. New
behaviour: if the provider reports the order refunded, set every line's
`refunded_amount = price_paid` (treat an externally-issued refund as full — we
can't attribute partial external refunds per line) and/or move the order to a
refunded status. This stays boolean-only; no provider return-shape change.

---

## 9. i18n

- `src/locales/en/admin.json`: add `admin.attendees.amount_refunded` ("Amount
  Refunded:") and form strings ("Refund the whole order", per-item labels). The
  existing `refunded` / `not_refunded` badge strings can stay (re-used for the
  derived badge) or be replaced with amount-based copy.
- Mirror into other `src/locales/*/admin.json` if locales are kept in sync.

---

## 10. CSV / export — `src/features/admin/attendees-csv.ts`

Add an "Amount Refunded" column to `standardAttendeeColumns`
(`formatPrice(String(a.refunded_amount))`), and the `csv.col.amount_refunded`
key. Shared with the calendar export, so it appears there too (intended).

---

## 11. Merge — `src/shared/merge/attendee-merge.ts`

Required (the merge runs regardless once the column exists): the loader (§6)
selects `refunded_amount`, and `bookingInsertStatement` copies it, so a moved
booking keeps its refunded amount; the dedup compare uses `refunded_amount` in
place of `refunded`.

---

## 12. OPEN QUESTION — check-in behaviour

Removing the boolean removes today's automatic "Cannot check in refunded tickets"
guard (`checkin.ts:101`). Pick one:

- **(A — recommended) Block on fully-refunded lines via the amount.** A line is
  "refunded" for check-in when `refunded_amount >= price_paid` (and `price_paid >
  0`). Preserves today's safety with no new schema; partial refunds don't block
  (the holder still paid part of it).
- **(B) Block on an order status.** Add an `is_refunded`/`blocks_checkin` flag to
  `attendee_statuses` and gate check-in on the attendee's status. Matches "use
  order statuses" most literally, but adds a status-schema change and an operator
  step (they must set the status for check-in to block).
- **(C) Don't auto-block.** Check-in never blocks on refunds; operators rely on
  the status/amount being visible. Simplest, least safe.

My recommendation is **A** (keeps the existing protection, no extra moving parts).
Tell me A/B/C and I'll lock it into §6.

---

## 13. Tests (100%, deterministic — AGENTS.md)

- **`recordLineRefund` unit (DB):** sets `refunded_amount`; caps at `price_paid`;
  adds on repeat (partial then more); **row identity** — same attendee+listing on
  two dates, refund one, assert only that row changes.
- **Refund route:** "whole order" refunds every line to `price_paid` and calls
  `refundPayment(ref, total)` with the right total; "per-item" stores the entered
  amounts and refunds their sum; `total === 0` rejected; provider failure records
  nothing. (Extend `test/lib/server-refunds.test.ts`; it already stubs
  `stripePaymentProvider.refundPayment` — assert the `amount` arg now.)
- **Provider:** Stripe/Square `refundPayment(ref, amount)` issues a partial refund
  with the right amount; omitted `amount` = full (existing tests).
- **Removal regression:** check-in (per §12 choice), merge (moved line keeps
  amount), scanner badge, CSV column, payment panel sum.
- **`refund-all`:** every not-fully-refunded line goes to `price_paid`.
- Run `deno task test:quality-audit` for the new tests.

---

## 14. Webhook payload (optional) — `src/shared/webhook.ts`

Drop `refunded` from the outbound attendee if present; optionally add
`refunded_amount` (+ `makeTestAttendee` factory + `src/docs/webhooks.ts`).
Out of scope unless wanted.

---

## 15. File-by-file checklist

| File | Change | Req? |
| --- | --- | --- |
| `migrations/schema.ts` | drop `refunded`, add `refunded_amount` on `listing_attendees`; bump `LATEST_UPDATE` | ✅ |
| `migrations/2026-06-21_attendee_refunded_amount.ts` | new migration: `recreateTable` + `syncTriggers` | ✅ |
| `migrations.ts` | import + append to `MIGRATIONS` | ✅ |
| `types.ts`, `attendee-types.ts` | `Attendee`/`ListingAttendeeRow`: −`refunded`, +`refunded_amount` | ✅ |
| `attendees/queries.ts` | selects: −`refunded`, +`refunded_amount` (`EA_COLS`, left-join, by-tokens) | ✅ |
| `attendees/update.ts` | replace `markRefunded` with `recordLineRefund` (single-row, capped) | ✅ |
| `attendees/pii.ts` | map `refunded_amount`; drop `refunded` | ✅ |
| `attendees-edit.ts`, `attendees-merge.ts`, `atomic-update.ts` | loaders select `refunded_amount` | ✅ |
| `attendee-refunds.ts` | new per-item form handler; redefine `getRefundable` | ✅ |
| `payments.ts` + `stripe.ts`/`square.ts`/`sumup-provider.ts` (+providers) | `refundPayment(ref, amount?)` partial refund | ✅ |
| `attendees.tsx` (refund form + `PaymentDetails` sum) | UI | ✅ |
| `checkin.ts` (+ scanner) | move off boolean (per §12) | ✅ |
| `merge/attendee-merge.ts` | carry `refunded_amount`; dedup compare | ✅ |
| `attendee-form-model.ts` + `attendee-form.tsx` | `AttendeeBooking.refundedAmount`; per-line display | ✅ |
| `attendee-columns.ts` / `scanner.tsx` | badge from `refunded_amount` | ✅ |
| `attendees-csv.ts` + csv locale | export column | ✅ |
| `locales/.../admin.json` | form + amount strings | ✅ |
| Tests (§13) | coverage | ✅ |
| `webhook.ts` (+docs/factory) | payload | ⭕ optional |

---

## 16. Edge cases & limitations

- **Booking fees aren't refundable via this form.** `price_paid` is ticket-only,
  so the per-item cap excludes the fee. Refunding a fee is a manual provider
  action. Documented limitation, not a bug.
- **Merged attendees with >1 original payment.** After a merge an attendee can
  hold lines from different payments, but only one `payment_id` is stored.
  Refunding more than that payment covered will be rejected by the provider. Rare;
  flag in the activity log when a refund fails.
- **Repeated/incremental refunds** are supported: the input max is the *remaining*
  refundable and `recordLineRefund` adds-and-caps, so refunding £2 then £3 of a
  £10 line leaves `refunded_amount = 5`.
- **Free lines** (`price_paid = 0`): max refundable is 0; nothing to do.
- **Aggregates/capacity** unchanged by refunds (no trigger fires; income still
  counts the rows).

---

## 17. Rollout / safety

1. The migration recreates `listing_attendees` once (drops `refunded`, adds
   `refunded_amount`, re-creates its indexes + aggregate triggers). Model exists
   (`2026-06-18_answer_modifiers.ts`).
2. Fresh DBs get the final shape from the declarative schema on first boot.
3. No data loss of consequence — there are no refunds to lose; `refunded` was
   all-zero.
4. The provider change is backward-compatible (`amount` optional), so any
   un-migrated caller still does a full refund.

---

## 18. Definition of done

- [ ] Migration recreates `listing_attendees` (no `refunded`, has
      `refunded_amount`); `verify()` passes; `SCHEMA_HASH`/`LATEST_UPDATE` updated.
- [ ] `recordLineRefund` writes one row (by `start_at`), caps at `price_paid`,
      accumulates on repeat — tested incl. the two-dates identity case.
- [ ] `refundPayment(ref, amount?)` issues partial refunds on Stripe/Square;
      omitted `amount` = full; SumUp partial verified or per-item disabled for it.
- [ ] Refund form: "whole order" (default) and per-item (0…remaining) both work;
      total refunded at the provider matches; provider failure records nothing.
- [ ] `refunded` boolean fully removed; every former reader migrated
      (check-in per §12, scanner, merge, form-model, templates, CSV, types,
      selects).
- [ ] Payment panel shows the **summed** order refund; per-line amounts visible.
- [ ] Tests added (§13); `deno task test:coverage` 100% & deterministic;
      `test:quality-audit` clean.
- [ ] `deno task precommit` (typecheck, `lint:ci`, tests, `cpd` 0%) passes.
- [ ] §12 (check-in) answered and implemented.

---

## What changed from v1 & why it's simpler

Your decisions removed three whole problem areas the earlier draft wrestled with:

- **No "read the amount back" from the provider.** We now *tell* the provider the
  amount, so `refundPayment` stays boolean — deleting the return-shape change, the
  `isPaymentRefunded` widening, the Stripe `retrievePaymentIntent` / Square
  lower-layer fixes, and the all-callers sweep.
- **No multi-line fan-out guessing.** The operator picks per-item amounts in the
  form, so there's nothing to allocate and no need for a per-line payment marker.
- **No provenance/backfill.** No existing refunds ⇒ no historical estimates to
  label.

What it *added*: removing the `refunded` boolean (a broad but mechanical refactor)
and partial refunds at the provider (a small, additive change). Net: a clearer
model — **state = order status, money = `refunded_amount` per item** — and one
open question (check-in, §12).
