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

Check-in behaviour is also decided (§12): a ticket is blocked from check-in once
it is **fully** refunded (`refunded_amount >= price_paid`).

One design decision remains, surfaced by review (§16): **how to scope a refund to
the right payment** when an order has more than one (balance-paid reservations,
or merged attendees). The amount/UI/migration are all specified; this is about
*which provider payment* a refund hits. My recommendation is to **record the
balance payment reference at settle-time** (so reservations refund correctly) and
**block refunds on merged multi-payment attendees** until a per-line key exists —
but it adds scope, so it's flagged rather than assumed. Everything else is fully
specified.

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

- A **"Refund all ticket lines"** checkbox, **checked by default**. Checked =
  refund each ticket line to its `price_paid` (everything still owed on the
  ticket lines). **Note (review):** call it "all ticket lines", not "the whole
  order" — booking fees are not refundable through this form (§16), so on a
  fee-bearing order this does *not* return 100% of what the customer paid. The
  copy must not promise a full-order refund.
- When **unchecked** (pure-CSS reveal, like the existing `show_all` pattern in the
  attendee form), a row per booking line in the order:
  - listing name **and the booking date/range** for daily/customisable bookings
    (review): the same listing can appear on several `start_at` dates with the
    same name and price, so the date is what makes the rows distinguishable. The
    row submits the booking's **row key (`start_at`)** so the write hits the
    right line (§5).
  - "Paid: £X.XX" (the line's `price_paid`),
  - an amount input in **major currency units**, `min=0`, `max=` the line's
    **remaining refundable** — both produced with `toMajorUnits` and parsed back
    with `toMinorUnits`/`parseMoneyMinor` (`src/shared/currency.ts`), **never a
    hard-coded `/100`** (review: JPY and 3-decimal currencies would be wrong).
    Server converts and re-clamps on submit (never trust the client).
- Confirm field (the existing name/identifier confirmation) + submit.

Optionally, a status selector defaulting to a "Refunded" order status when one
exists, so the operator marks state and money in one step. Nice-to-have; the
operator can also change status on the normal edit form.

### 2b. Submit — `POST .../refund`

`src/features/admin/attendee-refunds.ts`:

0. **Load the whole order, not one row (review).** Today's refund handlers load a
   single flattened attendee/listing row (`loadAttendeeForListing` /
   `getListingWithAttendeeRaw`, `attendees-route-helpers.ts`). The form and the
   POST both need **every** booking line of the order, so add an all-bookings
   loader (the attendee's `listing_attendees` rows + listing names) used for
   rendering *and* validation. Without it "refund the whole order" only sees the
   URL listing's line.
1. Parse the form. Convert each entered major-unit value to minor units
   server-side and clamp to `0 … remaining refundable` per line (integers). If
   "whole order" is checked, use each line's remaining refundable.
2. `total = sum(per-item amounts)`. If `total === 0`, reject ("nothing to refund").
3. Require a `payment_id` (the order's payment). `provider.refundPayment(payment_id,
   total, idempotencyKey)` — **partial refund of `total`** (§3), with a stable
   idempotency key (§3, review) so a double-submit can't stack refunds.
4. On success, write **all** per-line `refunded_amount` updates in **one batch /
   transaction** (review): the provider has already moved the money, so the local
   record must be all-or-nothing — never "provider refunded, only some rows
   updated". Use `executeBatch` with one `recordLineRefund`-style statement per
   non-zero line (§5). Log the activity.
5. On failure, redirect with an error; record nothing.

"Refund everything" therefore = each line refunded to its `price_paid`; a partial
refund = the operator's per-line numbers.

### 2c. Bulk — `POST /admin/listing/:id/refund-all`

Keep it; it refunds every **not-fully-refunded** line to its `price_paid`,
batched as today (`REFUND_BATCH_LIMIT`). "Refundable" is redefined in §6.

**Group by order before calling the provider (review).** The bulk loader returns
one row per `listing_attendees` line, so an attendee booked on two dates for the
listing appears twice with the **same `payment_id`**. A line-oriented loop would
call the provider twice for one payment (duplicate/again-failing refund) while
recording only some lines. Group the lines by attendee/`payment_id`, refund each
payment **once** with the summed remaining amount, then write all that order's
lines atomically (§2b step 4).

---

## 3. Provider layer — add partial refunds (+ idempotency)

We are *telling* the provider what to refund, so the return stays a boolean. No
return-shape churn, no reading amounts back, no caller sweep. Two additions:

- `PaymentProvider.refundPayment(ref: string, amount?: number, idempotencyKey?:
  string): Promise<boolean>` — `amount` omitted = full refund (today's behaviour,
  so existing callers like the webhook auto-refund are untouched).
- **Stripe** (`src/shared/stripe.ts`): `s.refunds.create({ payment_intent: ref,
  amount }, { idempotencyKey })` — `amount` is the partial-refund field; omit for
  full.
- **Square** (`src/shared/square.ts`): pass the chosen `amount` as
  `amountMoney.amount` (it currently reads the *full* payment amount), and pass
  the caller's `idempotencyKey` **instead of the fresh `crypto.randomUUID()` it
  generates per call** (`square.ts:624`) so retries dedupe.
- **SumUp**: confirm partial-refund support. If it is full-only, the per-item UI
  must be hidden **and the POST handler must reject any refund whose total is less
  than the provider transaction total** server-side (review) — a stale/crafted
  POST otherwise refunds the whole transaction (`sumup.ts` refunds in full) while
  storing only a partial `refunded_amount`. Note this is stricter than "reject
  non-full ticket refund": because the form caps at `price_paid` and excludes
  booking fees (§16), even the **default "all ticket lines"** total is *less than*
  the provider transaction whenever a fee was charged — so for SumUp, fee-bearing
  orders can't be fully refunded through this form at all and must be refused (or
  refunded out-of-band). Don't rely on hiding controls alone.

**Idempotency / double-submit (review).** Partial amounts make a duplicate
submission materially worse than today's full-refund retry: two concurrent £5
POSTs could both succeed before either records `refunded_amount`, turning a £5
refund into £10. A **single-use form token is not sufficient** — two tabs/two
admins render *different* tokens for the same remaining balance, get *different*
provider idempotency keys, and both succeed. The guard must be tied to the
**current refunded amounts**, not the form: derive the provider idempotency key
deterministically from `(payment_id, per-line target amounts)` so identical
requests dedupe at the provider, **and** gate locally on the live remaining
refundable. Do **not** "reserve" by writing the *final* `refunded_amount` before
the provider call (review) — a provider failure would then leave the line
recorded as refunded with no money moved, contradicting "provider failure records
nothing". Use a **separate pending-refund reservation** (or an amount-conditional
write applied only *after* provider success) so failure leaves no trace. This
must land **with** partial amounts, not after.

`isPaymentRefunded` is unchanged (still boolean) — see the refresh path (§8).

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

### 4b. Migration — add the column first, *then* recreate the table

Removing a column needs a table rebuild, not `ADD COLUMN`. **Order matters
(review, P1):** `recreateTable` rebuilds from the *current* SCHEMA and copies via
`INSERT INTO …_new (…, refunded_amount, …) SELECT …, refunded_amount, … FROM
listing_attendees` — so `refunded_amount` must already exist on the old table
before the recreate, or the copy SELECT fails. The fix is to use the
`schemaMigration` wrapper, which runs `applySchemaChanges()` (the ADD COLUMN)
**before** the `after` hook — exactly how `2026-06-18_answer_modifiers.ts` adds
columns via `recreateTable`:

```ts
// src/shared/db/migrations/2026-06-21_attendee_refunded_amount.ts
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-21_attendee_refunded_amount",
  "Add per-line refunded_amount to listing_attendees and drop the refunded boolean (refund state moves to order statuses)",
  // applySchemaChanges runs first: ADD COLUMN refunded_amount onto the old table.
  { columns: { listing_attendees: ["refunded_amount"] } },
  // after(): now the column exists, recreateTable rebuilds from SCHEMA —
  // copying surviving columns (so `refunded` is dropped, data discarded — there
  // are no refunds) and re-creating indexes + aggregate triggers.
  async ({ recreateTable, syncTriggers }) => {
    await recreateTable("listing_attendees");
    await syncTriggers();
  },
);
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
    (must be `COALESCE(ea.refunded_amount, 0) AS refunded_amount` — keep the
    `AS <field>` alias, or libsql exposes the column under the expression text and
    `decryptAttendeeFields` silently reads `0`), `getAttendeesByTokens`.
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
  tickets. Move these to the **fully-refunded** test (decided, §12): a line is
  blocked when `refunded_amount >= price_paid` (and `price_paid > 0`). A helper
  like `isFullyRefunded(line)` keeps the rule in one place; partial refunds do
  **not** block.
- **Check-in write path (review).** `updateCheckedIn`
  (`attendees/update.ts:21`) writes by `(attendee_id, listing_id)` only, so for an
  attendee booked on the same listing on two dates, checking in one date would
  also flip the fully-refunded date. Carry `start_at` (or the row id) through the
  token/scanner path and pin the UPDATE to the exact row — the same row-identity
  fix as `recordLineRefund` (§5).
- **Legacy baseline backfill (review).** `backfillListingAttendees` in
  `src/shared/db/migrations/schema-sync.ts` (~`:236-259`) requires and inserts the
  old `refunded_v2` shape when reconstructing `listing_attendees` from a very old
  `attendees`-only database. Once `refunded` leaves the schema, that backfill must
  stop writing it and map the old value to `refunded_amount` (or simply drop it —
  a legacy refunded row can backfill `refunded_amount = price_paid`). Add
  `schema-sync.ts` to the checklist so this legacy path isn't left writing a
  dropped column.
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
- **Operator guide (review).** The admin refunds guide
  (`src/locales/en/guide.json` ~`:147-152`, `:276-277`, rendered by the refunds
  guide section under `src/ui/templates/admin/guide/`) currently states that
  individual refunds are always full, partial refunds are unsupported, and booking
  fees are refunded. All three are now false — update the guide copy (and any
  per-locale copies) so the documentation matches the new partial-refund form and
  the fee exclusion. This is required work, not optional.

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

## 12. Check-in behaviour (decided: block when fully refunded)

Removing the boolean removed today's automatic "Cannot check in refunded tickets"
guard (`checkin.ts:101`). **Decision (owner, 2026-06-21): block when fully
refunded.** A line counts as refunded for check-in when `refunded_amount >=
price_paid` (and `price_paid > 0`); partial refunds do not block (the holder
still paid part of it).

- Replace the `!attendee.refunded` filter in `checkin.ts` with
  `!isFullyRefunded(line)`, and update the scanner badge/guards
  (`scanner.ts`, `scanner.tsx`, `scanner.js`, `manual-checkin.ts`) to the same
  rule. Keep `isFullyRefunded` in one shared place so check-in, the scanner, and
  the badge agree.
- This preserves today's protection with no new schema and no extra operator
  step. (Rejected alternatives: a `blocks_checkin` flag on `attendee_statuses` —
  more schema + an operator action; or no auto-block at all — least safe.)

---

## 13. Tests (100%, deterministic — AGENTS.md)

- **`recordLineRefund` unit (DB):** sets `refunded_amount`; caps at `price_paid`;
  adds on repeat (partial then more); **row identity** — same attendee+listing on
  two dates, refund one, assert only that row changes.
- **Refund route — multi-line:** an order spanning two listings shows/records
  **all** lines (not just the URL listing); "whole order" refunds every line to
  `price_paid` and calls `refundPayment(ref, total)` with the right total;
  "per-item" stores the entered amounts and refunds their sum; `total === 0`
  rejected; provider failure records nothing. (Extend
  `test/lib/server-refunds.test.ts`; it already stubs
  `stripePaymentProvider.refundPayment` — assert the `amount` arg now.)
- **Units:** an operator entering `5.00` records `500` minor units (not `5`);
  `max` reflects remaining refundable in major units.
- **Idempotency / double-submit:** two identical partial-refund POSTs result in a
  **single** refund (provider called once / deduped, `refunded_amount` not
  stacked).
- **Atomicity:** if a per-line write fails after provider success, the batch
  rolls back (no partial local record). (Assert via a forced failure on one
  statement.)
- **Provider:** Stripe/Square `refundPayment(ref, amount)` issues a partial refund
  with the right amount + idempotency key; omitted `amount` = full (existing
  tests); a **non-full SumUp** refund POST is rejected server-side.
- **Removal regression:** check-in blocks a **fully**-refunded line but allows a
  **partially**-refunded one (§12); check-in writes hit the right dated row
  (same attendee+listing, two dates); merge (moved line keeps amount); scanner
  badge; CSV column; payment panel sum.
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
| `migrations/2026-06-21_attendee_refunded_amount.ts` | new migration: **`schemaMigration(…, after)`** — ADD COLUMN then `recreateTable` + `syncTriggers` (order matters, §4b) | ✅ |
| `migrations.ts` | import + append to `MIGRATIONS` | ✅ |
| `migrations/schema-sync.ts` | legacy `backfillListingAttendees`: stop writing `refunded`/`refunded_v2`, map to `refunded_amount` | ✅ |
| `types.ts`, `attendee-types.ts` | `Attendee`/`ListingAttendeeRow`: −`refunded`, +`refunded_amount` | ✅ |
| `attendees/queries.ts` | selects: −`refunded`, +`refunded_amount` (`EA_COLS`, left-join, by-tokens) | ✅ |
| `attendees/update.ts` | `markRefunded`→`recordLineRefund` (single-row, capped); `updateCheckedIn` gains `start_at` row identity | ✅ |
| `attendees/pii.ts` | map `refunded_amount`; drop `refunded` | ✅ |
| `attendees-edit.ts`, `attendees-merge.ts`, `atomic-update.ts` | loaders select `refunded_amount` | ✅ |
| `attendee-refunds.ts` | per-item form handler; all-order loader; major→minor conversion; idempotency guard; atomic batch writes; **bulk: group by order/payment, one provider call each**; redefine `getRefundable` | ✅ |
| `src/locales/en/guide.json` + refunds guide template | rewrite refunds guide: partial refunds supported, fees not refundable (§6) | ✅ |
| `payments.ts` + `stripe.ts`/`square.ts`/`sumup-provider.ts` (+providers) | `refundPayment(ref, amount?, idempotencyKey?)`; SumUp reject partial server-side | ✅ |
| `attendees.tsx` (refund form, major-unit inputs + `PaymentDetails` sum) | UI | ✅ |
| `checkin.ts` (+ scanner, token path) | move off boolean (§12); carry `start_at` to pin check-in writes | ✅ |
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
- **Balance-paid reservations need the balance payment ref (review).**
  `settleAttendeeBalance` folds the later balance payment into a line's
  `price_paid` **without** updating `attendees.payment_id`
  (`attendees/balance.ts:170-183`). So "refund the whole order" would try to
  refund deposit+balance against the **deposit** payment id — the provider refunds
  at most the deposit and the balance stays unrefundable from the app. **Must
  handle, not just note:** either record the balance payment reference at
  settle-time (so the refund can target both payments), or cap the refundable
  total per payment, or disable the refund flow for settled reservations. Pick one
  before building (recommend: store the balance payment ref alongside the deposit
  so both can be refunded).
- **Merged attendees with >1 original payment (review).** A merge can leave one
  attendee holding lines paid by a *different*, discarded payment while only the
  target's single `payment_id` is kept (`attendees-merge.ts:189-194`). The
  per-item form could then refund a moved (source-paid) line against the target's
  payment: if the amount fits the target payment's remaining balance the provider
  *succeeds*, but `recordLineRefund` marks a line whose money came from another
  payment — so the records no longer match the money returned. **Must handle:**
  track a per-line/order payment key, or **block refunds on merged
  multi-payment attendees** until one exists. (This is the same per-line-payment
  gap as reservations; one marker solves both.)
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

- [ ] Migration **adds `refunded_amount` (ADD COLUMN) before** `recreateTable`
      (via the `schemaMigration(…, after)` wrapper, §4b); ends with no `refunded`,
      has `refunded_amount`; `verify()` passes; `SCHEMA_HASH`/`LATEST_UPDATE`
      updated. Legacy `schema-sync.ts` backfill no longer writes `refunded`.
- [ ] `recordLineRefund` writes one row (by `start_at`), caps at `price_paid`,
      accumulates on repeat — tested incl. the two-dates identity case.
- [ ] `refundPayment(ref, amount?, idempotencyKey?)` issues partial refunds on
      Stripe/Square; omitted `amount` = full; SumUp rejects any refund below the
      provider transaction total (incl. fee-bearing "all ticket lines").
- [ ] Refund form loads **all order lines**; default "all ticket lines" and
      per-item (0…remaining) both work, inputs in **major units via
      `toMajorUnits`/`toMinorUnits`** (not `/100`); each row shows its booking
      **date** and submits its `start_at` row key; total refunded at the provider
      matches; provider failure records nothing; per-line writes **atomic** (one
      batch after provider success).
- [ ] **Idempotency:** a double-submit / concurrent partial refund (incl. two
      tabs/admins) cannot stack — provider key derived from `(payment_id, target
      amounts)` + a local guard on **live remaining refundable** (not a form
      token, and not by pre-writing the final `refunded_amount`).
- [ ] **Bulk refund** groups lines by order/`payment_id` and calls the provider
      **once per payment** with the summed amount.
- [ ] Operator **refunds guide** (`guide.json` + template) rewritten: partial
      refunds supported, booking fees not refundable.
- [ ] **Per-line payment scoping decided** (§16): balance-paid reservations and
      merged multi-payment attendees either refund the correct payment(s) or are
      blocked — never silently mis-record. SumUp non-full refunds rejected
      server-side.
- [ ] `refunded` boolean fully removed; every former reader migrated
      (check-in per §12, scanner + `updateCheckedIn` row identity, merge,
      form-model, templates, CSV, types, selects, legacy `schema-sync.ts`
      backfill).
- [ ] Payment panel shows the **summed** order refund; per-line amounts visible.
- [ ] Tests added (§13); `deno task test:coverage` 100% & deterministic;
      `test:quality-audit` clean.
- [ ] `deno task precommit` (typecheck, `lint:ci`, tests, `cpd` 0%) passes.
- [ ] Check-in blocks fully-refunded lines (`refunded_amount >= price_paid > 0`)
      and allows partially-refunded ones (§12), via a shared `isFullyRefunded`.

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
and partial refunds at the provider (a small, additive change — plus idempotency
and atomic per-line writes, which partial amounts make necessary). Net: a clearer
model — **state = order status, money = `refunded_amount` per item**, check-in
blocks only fully-refunded lines. One residual decision remains: per-payment
scoping for reservations / merged orders (§16) — recommendation given.
