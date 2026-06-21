# Plan: track a `refunded_amount` for attendees

Goal: record **how much money was refunded** for a booking, not just the
boolean "was it refunded?" we store today. The amount is in **minor units**
(pence/cents), matching every other money column in the system.

---

## 0. TL;DR / the one decision to make first

The request says "add a `refunded_amount` column to **attendees**". The
codebase reality is that the existing refund state does **not** live on the
`attendees` table — it lives on **`listing_attendees`** (the per-booking-line
join table):

- `listing_attendees.refunded` — `INTEGER NOT NULL DEFAULT 0` (the 0/1 flag)
- `listing_attendees.price_paid` — `INTEGER NOT NULL DEFAULT 0` (minor units paid for that line)
- `markRefunded(attendeeId, listingId)` sets `refunded = 1` for **one line**

The `Attendee` TypeScript type is a *flattened join* of one `attendees` row +
one `listing_attendees` row, which is why `attendee.refunded` and
`attendee.price_paid` *read* like attendee fields in the code even though they
are physically per-line.

**Recommendation: put `refunded_amount` on `listing_attendees`, mirroring
`refunded` and `price_paid`.** Reasons:

1. It sits next to the data it describes (`price_paid`, `refunded`) and is
   written by the same code path (`markRefunded`).
2. A refund is fundamentally per-line today (`markRefunded` takes
   `listingId`). An attendee booked onto two listings can have one line
   refunded and the other not.
3. Per-line is strictly more granular — an attendee-level total is always
   recoverable as `SUM(refunded_amount)` over the attendee's lines, but the
   reverse is not true.
4. It matches the project's "mirror the existing structure" preference
   (AGENTS.md).

The flattened `Attendee` type still gains a `refunded_amount` field, so from
the route/template layer it still *looks* like "an attendee's refunded amount"
— satisfying the spirit of the request.

This plan is written for the **recommended (listing_attendees) approach**.
§11 documents exactly what changes if we instead put it on `attendees`.

> If you want the attendee-level design instead, say so and I'll re-issue the
> plan around §11; everything else here still applies.

---

## 1. How money & refunds work today (context for reviewers)

| Concept | Where it lives | Type | Notes |
| --- | --- | --- | --- |
| Amount paid for a booking line | `listing_attendees.price_paid` | `INTEGER` minor units | **Ticket revenue only** — excludes the booking fee (a separate `extras` line at checkout, not folded into any line's `price_paid`; see §8.5). Reservation balance payments *are* folded in by `settleAttendeeBalance`. Trigger-summed into `listings.income`. |
| Refunded? (per line) | `listing_attendees.refunded` | `INTEGER` 0/1 | Set by `markRefunded`. |
| Payment reference | encrypted `attendees.pii_blob` (`pi`) | string | Surfaced as `attendee.payment_id` after decryption. |
| Outstanding balance (order-level) | `attendees.remaining_balance` | `INTEGER` minor units | Reservations/part-payments. |

Refund flow:

- **Admin single refund** — `src/features/admin/attendee-refunds.ts`
  (`handleAttendeeRefund`): calls `provider.refundPayment(payment_id)` then
  `markRefunded(attendee.id, listingId)`.
- **Admin bulk refund** — same file (`processRefundAll` → `refundOneAttendee`):
  same two calls per refundable line.
- **Refresh from provider** — `src/features/admin/attendees-edit.ts`
  (`handleRefreshPayment`): polls `provider.isPaymentRefunded(...)` and, if the
  provider says refunded, calls `markRefunded`.
- **Webhook auto-refund** — `src/features/api/webhooks.ts:239`: refunds an
  *untrusted/invalid* checkout **before any attendee/line exists**. There is no
  row to attach an amount to, so this path is out of scope (see §9).

`markRefunded` is the single DB write for all in-scope paths
(`src/shared/db/attendees/update.ts`):

```ts
const setRefunded = updateListingAttendeeField("refunded");
export const markRefunded = (attendeeId, listingId) =>
  setRefunded(attendeeId, listingId, 1);
```

Key fact about the value to store: `provider.refundPayment()` returns a
**boolean** (full refund only). The underlying Stripe call
(`src/shared/stripe.ts:322`, `s.refunds.create(...)`) actually returns a
`Stripe.Refund` carrying the real refunded `amount`, but the
`PaymentProvider` interface throws it away. So the actual provider-refunded
amount is *available at Stripe/Square* but *not* at the interface today.

**DECIDED — `refunded_amount` stores the provider's actual refunded amount
(option B).** (Owner decision, 2026-06-21.) The alternative — recording the
line's `price_paid` — was rejected because it is only the *ticket* portion and
diverges from the money actually returned in three real configurations (booking
fees, balance-paid reservations, multi-line orders; see **§8.5**). Option B is
the one number correct in all of them: exactly the money the provider returned.

`price_paid` survives only as a **fallback**, used in two narrow places:

- **SumUp**, whose API returns no refund amount (boolean only); and
- the **historical backfill** (§18), where the provider amount is no longer
  retrievable for already-refunded rows.

The cost of option B is the interface work in **§10** (widen `refundPayment` and
`isPaymentRefunded`, stop the lower Stripe/Square layers discarding the amount,
and update every caller). Where the plan below still says "under option B", read
it as "the chosen path"; "option A / fallback" means the two narrow cases above.

---

## 2. Design decisions

1. **Column**: `refunded_amount INTEGER NOT NULL DEFAULT 0` on
   `listing_attendees`. Minor units, never null, defaults to 0 (so existing
   rows and non-refunded rows read as 0 — "nothing refunded").
2. **Value written**: `markRefunded(attendeeId, listingId, startAt, amount?)`
   sets `refunded = 1` and `refunded_amount = amount` on the **one** line
   identified by (listing_id, attendee_id, start_at — §6), in a single atomic
   UPDATE so the flag and amount can never drift. The `amount` is:
   - the **provider's actual refunded amount** (option B) where available — the
     refund routes already hold the provider result and can pass it in; or
   - the line's **`price_paid`** as the fallback (`amount` omitted → the SQL
     copies `price_paid`), used for SumUp and the historical backfill.

   See §8.5 for why `price_paid` alone is not a reliable amount, and §10 for the
   small interface change that surfaces the provider amount.
3. **Idempotency**: re-running `markRefunded` is harmless — it re-sets
   `refunded = 1, refunded_amount = <amount>` (a copy, never an accumulate), so
   a repeat call lands the same value. (The routes also guard against
   double-refunding at the provider via the `refunded` check.)
4. **No trigger changes**. The `listings` aggregate triggers
   (`LISTING_AGGREGATE_TRIGGERS`) are scoped to `OF quantity, price_paid,
   listing_id`; writing `refunded_amount` won't fire them. This deliberately
   preserves existing behaviour ("refunded rows still count" toward
   capacity/income — refunds set a flag/amount, not `quantity`/`price_paid`).
5. **Type**: integer minor units, formatted for display with
   `formatCurrency()` (`src/shared/currency.ts`) exactly like `price_paid`.
6. **Future partial refunds**: give `markRefunded` an optional `amount`
   parameter defaulting to the line's `price_paid`. Today every caller uses the
   default; partial-refund support later only needs to pass a value (and widen
   the provider interface, §10). Documented, not built.

---

## 3. Schema & migration

### 3a. Declarative schema — `src/shared/db/migrations/schema.ts`

Add the column to the `listing_attendees` table definition, next to
`price_paid`:

```ts
["price_paid", "INTEGER NOT NULL DEFAULT 0"],
["refunded_amount", "INTEGER NOT NULL DEFAULT 0"], // minor units refunded for this line
["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
```

Update `LATEST_UPDATE` (append a clause describing the change), e.g.:

> "…; add a refunded_amount column to listing_attendees recording the amount
> (minor units) refunded for each booking line, set to the line's price_paid
> when it is refunded."

(`SCHEMA_HASH` recomputes automatically from the schema, so the version marker
changes even if `LATEST_UPDATE` were forgotten — but update it anyway.)

### 3b. Named migration file

Create `src/shared/db/migrations/2026-06-21_attendee_refunded_amount.ts`
(follow `2026-06-20_answer_active.ts`):

```ts
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-21_attendee_refunded_amount",
  "Add a refunded_amount column to listing_attendees recording how much " +
    "(minor units) was refunded for each booking line",
  {
    columns: { listing_attendees: ["refunded_amount"] },
  },
  // 4th arg: after() — runs post-ADD COLUMN. Backfill legacy refunded rows so
  // they don't report 0 (see §18; they cannot self-heal via the refresh path).
  async ({ getDb }) => {
    await getDb().execute(
      "UPDATE listing_attendees SET refunded_amount = price_paid WHERE refunded = 1 AND refunded_amount = 0",
    );
  },
);
```

> The `after` callback is **part of the required migration** (§18), not optional
> — without it every historical `refunded = 1` row reports `refunded_amount = 0`.
> `schemaMigration`'s 4th argument receives the `MigrationContext` (so `getDb`
> is available). Confirm `after` runs *after* `applySchemaChanges` (it does — see
> `define.ts`'s `up`).

`schemaMigration` runs `applySchemaChanges()` (ADD COLUMN for any missing
schema column) and the generated `verify()` asserts the live table has
`refunded_amount` (`verifyRequirement` → `assertLiveTableColumns`). A
`NOT NULL DEFAULT 0` column is safe to `ADD COLUMN` onto a populated table.

### 3c. Register the migration — `src/shared/db/migrations.ts`

- Add the import alongside the others.
- Append `attendeeRefundedAmountMigration` to the `MIGRATIONS` array (order
  matters — append at the end).

### 3d. Backup/restore

No work needed. Per AGENTS.md, `backup.ts` dumps every column (schema-driven
`SELECT *` via the `Table` helpers), so the new column round-trips
automatically. Worth a one-line confirmation while testing (export → import →
diff) but no code change.

---

## 4. Types

### 4a. `src/shared/db/attendee-types.ts`

Add to `ListingAttendeeRow` (used by token resolution, merge, refresh):

```ts
export type ListingAttendeeRow = {
  ...
  refunded: number;
  price_paid: number;
  refunded_amount: number; // minor units refunded for this line
  attachment_downloads: number;
};
```

### 4b. `src/shared/types.ts`

Add to the flattened `Attendee` interface (keep it next to `refunded` /
`price_paid`):

```ts
price_paid: string;       // existing (note: string on Attendee)
refunded: boolean;        // existing
refunded_amount: number;  // minor units refunded (0 when not refunded)
```

Note the asymmetry that already exists: `Attendee.price_paid` is a **string**
(stringified in `decryptAttendeeFields`), while on the DB row it's a number.
Keep `refunded_amount` a **number** (no decryption/stringify needed — it's a
plaintext integer like `remaining_balance`). This is the simplest, least
surprising choice.

---

## 5. Read paths (SELECTs)

`refunded_amount` must be selected wherever `refunded`/`price_paid` are, so the
flattened `Attendee`/`ListingAttendeeRow` carry it.

### 5a. `src/shared/db/attendees/queries.ts`

- `EA_COLS` (the per-line column list for joins): add `ea.refunded_amount`.
- `ATTENDEE_LEFT_JOIN_SELECT`: add
  `COALESCE(ea.refunded_amount, 0) as refunded_amount` (mirrors the other
  COALESCE'd join columns so left-join misses read as 0).
- `getAttendeesByTokens` — the explicit `listing_attendees` column list in
  Query 2 and the `bookingsByAttendee` row mapping: add `refunded_amount`.

### 5b. `src/features/admin/attendees-edit.ts`

`loadRefreshContext` selects an explicit `listing_attendees` column list — add
`refunded_amount` there too (keeps the `ListingAttendeeRow` shape complete).

### 5c. `src/features/admin/attendees-merge.ts` — `loadAttendeeBookings`

**Required, and easy to miss.** `loadAttendeeBookings` (the merge route's
loader) selects `listing_id, start_at, end_at, quantity, checked_in, refunded,
price_paid, attachment_downloads` into `ListingAttendeeRow[]`. It must also
select `refunded_amount`. This pairs with §14: the merge *insert* copies
`refunded_amount`, so if the loader doesn't select it the moved booking passes
`undefined` into the `NOT NULL` column. Read site (5c) and write site (§14) go
together — do not land one without the other.

### 5d. `src/shared/db/attendees/atomic-update.ts` — `loadExistingLines`

**Required.** `loadExistingLines` (used by the atomic add/edit attendee path)
selects `listing_id, start_at, end_at, quantity, checked_in, refunded,
price_paid, attachment_downloads` into `ListingAttendeeRow[]`. Once §4 adds
`refunded_amount` to `ListingAttendeeRow`, this SELECT must include it too —
otherwise the completed rows carry `refunded_amount === undefined`, breaking any
edit-form summary/copy/compare logic that reads the full row shape.

### 5e. Anywhere else selecting `listing_attendees` per-line columns

Grep check: `rg "checked_in, refunded, price_paid"` and
`rg "ea\\.refunded"` — update every explicit column list that already pulls
`refunded`/`price_paid` to also pull `refunded_amount`. Known sites are 5a–5d
(`queries.ts` ×2, `attendees-edit.ts`, `attendees-merge.ts`,
`atomic-update.ts`); re-run the grep at implementation time to confirm none
were added since.

---

## 6. Write path — `src/shared/db/attendees/update.ts`

Change `markRefunded` so the same atomic UPDATE records the amount. The current
generic `updateListingAttendeeField("refunded")` helper sets one constant
column, so `markRefunded` needs its own statement (the helper stays for
`setCheckedIn`):

```ts
const setCheckedIn = updateListingAttendeeField("checked_in");

/**
 * Mark ONE booking line refunded and record the refunded amount.
 *
 * The row identity is (listing_id, attendee_id, start_at) — the table's unique
 * index. Filtering by (attendee_id, listing_id) alone is NOT enough: an attendee
 * can book the same listing on several dates, so that predicate matches multiple
 * rows. With a single provider amount that would stamp the full amount onto every
 * dated row and double-count the SUM (review). Pass start_at (or the row id) to
 * target exactly one line.
 */
export const markRefunded = async (
  attendeeId: number,
  listingId: number,
  startAt: string | null,
  amount?: number,
): Promise<void> => {
  // `start_at IS ?` handles the NULL (standard-listing) case as well as a date.
  await execute(
    amount === undefined
      ? "UPDATE listing_attendees SET refunded = 1, refunded_amount = price_paid WHERE attendee_id = ? AND listing_id = ? AND start_at IS ?"
      : "UPDATE listing_attendees SET refunded = 1, refunded_amount = ? WHERE attendee_id = ? AND listing_id = ? AND start_at IS ?",
    amount === undefined
      ? [attendeeId, listingId, startAt]
      : [amount, attendeeId, listingId, startAt],
  );
};
```

Notes:
- **Row identity (review):** the added `start_at` filter is required so the write
  hits exactly one line. The existing boolean `markRefunded` already over-matches
  here (it marks every same-listing row), which is a latent bug today; option B's
  per-line amount makes it actively wrong (double-counted totals), so the
  signature gains `startAt`. **All callers change** to pass it —
  `attendee-refunds.ts` and `attendees-edit.ts` already hold the booking's
  `start_at` (the flattened `Attendee` carries the date), and the bulk path
  iterates rows it can key. (If a stable `listing_attendees.id` is threaded
  through instead, key on that — even simpler.)
- `refunded_amount = price_paid` copies the column in-SQL, so it always equals
  exactly what was paid for that line — no read-then-write race.
- No JSCPD concern: this is one helper, not duplicated logic. If the two
  branches trip the duplication check, fold them into one parameterised
  statement builder.
- The signature gains a **required `startAt`** (row identity, above) and an
  optional `amount`, so **all callers change** regardless of option. With
  **option B** the refund routes also pass the provider amount:
  `attendee-refunds.ts` (single + bulk) and the refresh path (§10) call
  `markRefunded(id, listingId, startAt, providerAmount)`. The no-amount form
  (`refunded_amount = price_paid`) is reserved for the **fallback** cases only —
  SumUp (no provider amount) and the historical backfill (§18). Do not assume
  callers are unchanged (the §20 DoD reflects this).

---

## 7. Decryption / row→Attendee mapping

`src/shared/db/attendees/pii.ts` → `decryptAttendeeFields` builds the
`Attendee` from a raw row. It already coerces `checked_in`, `price_paid`,
`refunded`. Add `refunded_amount` so the field is always present and numeric:

```ts
return {
  ...row,
  ...pii,
  checked_in: Boolean(row.checked_in),
  price_paid: String(row.price_paid),
  refunded: paidListing ? Boolean(row.refunded) : false,
  refunded_amount: paidListing ? Number(row.refunded_amount ?? 0) : 0,
  split_logistics_agents: Boolean(row.split_logistics_agents),
};
```

Mirror the `paidListing` gating used for `refunded`: on an unpaid listing,
payment/refund fields are suppressed, so `refunded_amount` reads 0 there too.

---

## 8. UI / display

### 8a. Payment details panel (primary surface) — `src/ui/templates/admin/attendees.tsx`

In `PaymentDetails` (the read-only payment block on the attendee edit page),
show the refunded amount next to the existing refund-status badge.

> **Multi-line caveat (review):** `attendee.refunded_amount` on this flattened
> `Attendee` is **one booking line's** value — `getAttendeeRaw` is a `queryOne`
> over a single `listing_attendees` row, not the order total. For an attendee
> with several booking lines (and especially after the §10b fan-out), this panel
> would **under-report** the total refund. Fix one of two ways: (a) sum
> `refunded_amount` across the attendee's loaded booking rows for the headline
> figure, or (b) move the amount into the per-line bookings table (§8d) so each
> line shows its own. The headline "Amount Refunded" must be the **sum**, not a
> single line.

```tsx
<p>
  <strong>{t("admin.attendees.refund_status")}</strong>{" "}
  {isRefunded ? (
    <span class="badge-alert">{t("admin.attendees.refunded")}</span>
  ) : (
    t("admin.attendees.not_refunded")
  )}
</p>
{isRefunded && attendee.refunded_amount > 0 && (
  <p>
    <strong>{t("admin.attendees.amount_refunded")}</strong>{" "}
    {formatCurrency(attendee.refunded_amount)}
  </p>
)}
```

### 8b. Refund confirmation page — same file

`adminRefundAttendeePage` warns "This will issue a full refund". Optionally show
the amount before confirming — but **do not present `attendee.price_paid` as "the
exact amount"**: per §8.5 it excludes booking fees and over-states balance-paid
reservations, so the operator would see the wrong figure. Either show the
provider/order total when available, or label it explicitly as a *ticket-only
estimate* (e.g. "≈ £10.00 ticket value; final refund set by the provider").

### 8c. Attendee table status column — `src/shared/columns/attendee-columns.ts`

The `status` column renders the refunded badge via `opts.renderStatus(row)`.
Optional: when refunded, include the amount in the badge/title (e.g.
`title="Refunded £5.00"`). Find `renderStatus` (it builds the check-in /
refunded badge) and thread `refunded_amount` through if we want it on the list.
Low priority.

### 8d. Form-model booking summary — `src/features/admin/attendee-form-model.ts`

`AttendeeBooking` + `attendeeBookingsFromLines` project a line into the
read-only bookings table. If we want the per-line refunded amount in that table:

- add `refundedAmount: number` to `AttendeeBooking`,
- set `refundedAmount: booking.refunded_amount` in `attendeeBookingsFromLines`,
- render it in the bookings table template (`attendee-form.tsx`).

Optional but nice for the multi-line case (where the flattened
`PaymentDetails` only reflects one line).

---

## 8.5 Accuracy of the recorded amount — when `price_paid` ≠ money refunded

> Added in response to PR review. `refunded_amount = price_paid` is correct for
> a full refund of a single-line, fee-free, non-reservation booking — but **not**
> in the three configurations below. Each is verified against current code.

1. **Booking fees are excluded from `price_paid`.** At checkout the booking fee
   is a separate `extras` line (`feeExtras`, `src/shared/checkout-pricing.ts:86-92`),
   and `paidByListing` (`src/features/api/webhooks.ts:587-597`) sums only the
   ticket lines into each line's `price_paid`. So a £10 ticket + £1 fee stores
   `price_paid = 1000`, but a full provider refund returns **1100**. Recording
   `price_paid` under-reports by the fee.
2. **Balance-paid reservations fold extra money into `price_paid`.**
   `settleAttendeeBalance` (`src/shared/db/attendees/balance.ts`) does
   `UPDATE listing_attendees SET price_paid = price_paid + <balance>` on the
   first line, while the attendee's stored `payment_id` stays the **original
   deposit** reference. Refunding that stored payment returns only the deposit,
   but `price_paid` now holds deposit + balance — so `price_paid`
   **over-reports** the actual refund. (And the balance was a *second* payment
   the stored `payment_id` can't even refund.)
3. **Multi-line orders share one payment.** `provider.refundPayment(payment_id)`
   refunds the *entire* order, but the single-refund and refresh paths call
   `markRefunded(attendee.id, listingId)` for **one** line only
   (`attendee-refunds.ts:101-111`, `attendees-edit.ts:86-88`). The other lines
   keep `refunded = false`, `refunded_amount = 0` even though their money was
   returned. (This is a **pre-existing** quirk of the boolean `refunded` flag,
   not introduced here — but `refunded_amount` makes the under-report visible in
   money terms.)

**Implications for the design (with option B decided):**

- Cases 1 and 2 are **resolved by the chosen option B**: the provider's refund
  response is exactly the money returned, so fees are included and a deposit-only
  refund records the deposit (not the inflated `price_paid`). This is why B was
  chosen over `price_paid`.
- Case 3 still needs a **write-fan-out**, independent of the amount source: when
  an order-level refund succeeds, mark every line that payment covered, not just
  the operator's line. **Scoping that fan-out correctly is the one remaining open
  sub-decision** — attendee-level `payment_id` is insufficient because a merge
  can leave one attendee holding lines from several payments (see §10b). It needs
  either a new per-line payment/order marker or the smaller "accept + document"
  choice (§10b).
- The historical **backfill** (§18) still uses the `price_paid` fallback (the
  provider amount isn't retrievable for old rows), so backfilled rows inherit the
  fee/reservation inaccuracy. Label those as approximate (§18) — going forward,
  newly-refunded rows carry the exact provider amount.

---

## 9. Webhook auto-refund path

`src/features/api/webhooks.ts:239` refunds *untrusted/invalid* checkout
sessions that never become an attendee. There is no `listing_attendees` row, so
there is nothing to set `refunded_amount` on — **no amount-storage change here.**

**But it is not fully out of scope under option B.** This caller uses the result
as a boolean: `if (await provider.refundPayment(paymentReference)) { … }`. If
§10a changes `refundPayment` to return an object, `{ ok: false }` is **truthy**,
so a *failed* defensive refund would be logged/treated as a success. Therefore
§10a must update **every** `refundPayment` caller — including this one — to
inspect `.ok`. Listed here so it isn't missed; covered by the existing webhook
refund tests (`server-webhooks.test.ts` has many `refundPayment` stubs whose
return shape would need updating).

(If we ever want to ledger those defensive refunds, that's a separate
"refunds log" table, not this column.)

---

## 10. Recording the *provider's actual* refunded amount + the multi-line fan-out

This was "optional/deferred" in the first draft; PR review (§8.5) showed
`price_paid` is wrong in common configurations, and the owner has now **chosen
option B** — so §10a is **core required work**, not a nice-to-have. §10b (the
multi-line fan-out scoping) remains the one open sub-decision.

### 10a. Surface the provider amount (option B — REQUIRED)

Widen the provider interface so the real refunded amount reaches `markRefunded`.
This is **two layers**, not just the provider wrapper:

1. **Interface + wrappers** — `PaymentProvider.refundPayment(ref):
   Promise<boolean>` → `Promise<{ ok: boolean; amount?: number }>` (or
   `number | null`). Update `stripe-provider.ts`, `square-provider.ts`,
   `sumup-provider.ts`.
2. **Lower API layers** (the easy-to-miss part):
   - **Stripe — `refundPayment` only:** `src/shared/stripe.ts:322` already
     returns `Stripe.Refund` (carrying `.amount`), so for the *refund* path only
     the provider wrapper needs to stop discarding it. **But the refresh path is
     different** (review #1): it reads `retrievePaymentIntent`, whose narrowing
     `StripePaymentIntentFields` reduces `latest_charge` to `{ refunded }`
     (`stripe.ts:72-87`), throwing away `amount_refunded`. To surface the
     provider amount on refresh, that narrowing (and its tests) must add the
     refunded amount too. So "no lower-layer change" holds for `refundPayment`,
     **not** for the refresh path.
   - **Square** — `src/shared/square.ts:608` *computes* the refund amount
     (`payment.amountMoney.amount`) but its `withClient` callback returns only
     `true`, and the REST adapter (`refunds.refundPayment`, ~`:343`) returns
     `{}`. **`square.ts` (and its tests) must be changed to return the amount**;
     changing `square-provider.ts` alone leaves Square falling back to
     `price_paid`. (For the refresh path, Square reads refund state via its own
     retrieve path — check it surfaces the amount too.)
   - **SumUp** — returns boolean only → `amount` undefined → fall back to
     `price_paid` (acceptable; documented).
3. **All `refundPayment` callers must read the new shape** (see also §9):
   - `attendee-refunds.ts` single (`:101-112`) + bulk (`:160-163`) — branch on
     `.ok`, pass `.amount` into `markRefunded(id, listingId, startAt, amount)`.
   - `webhooks.ts:239` auto-refund — branch on `.ok` (no amount stored).
4. **Refresh path needs the amount too (review #3) — and `isPaymentRefunded` has
   more than one caller (review #4).** `handleRefreshPayment` does **not** call
   `refundPayment`; it calls `isPaymentRefunded(ref)` → boolean, then
   `markRefunded`. To record the provider's actual amount here, `isPaymentRefunded`
   must also return the amount (e.g. `Promise<{ refunded: boolean; amount?:
   number }>` or a companion `getRefundedAmount(ref)`), the Stripe/Square lower
   retrieve layers must stop discarding it (Stripe: the `latest_charge` narrowing
   above), and **every** `isPaymentRefunded` caller must read `.refunded` rather
   than truthiness:
   - `attendees-edit.ts:86` `handleRefreshPayment` — pass the amount into
     `markRefunded`.
   - `webhooks.ts:251` `tryRefund` fallback — `if (await
     provider.isPaymentRefunded(ref))` after a failed refund; an object
     `{ refunded: false }` is truthy, so a failed defensive refund would be
     mis-classified as already-refunded unless this reads `.refunded`.
   This widens a second interface method across all three providers.

Cost: touches all three providers + two lower API layers + every
`refundPayment`/`isPaymentRefunded` caller, and many provider tests/stubs (~100
`refundPayment` stub sites in `test/`, plus `isPaymentRefunded` stubs). The
mechanical fix is to update each stub's return shape; budget for it.

### 10b. Mark every line covered by the payment (case 3 from §8.5)

`provider.refundPayment(payment_id)` refunds the **whole order**, so on success
the routes must mark all the lines that payment covered — not just the operator's
line.

**The naive predicate "mark all of the attendee's lines" is wrong (review #1).**
The attendee↔payment relationship is not 1:1 after a merge: `applyAttendeeMerge`
copies a *source* attendee's booking lines onto the *target* while keeping only
the target's `payment_id` (`attendees-merge.ts:190-194`,
`merge/attendee-merge.ts:405-420`). So a single attendee can hold lines paid by
**different** (now-discarded) payments. Fanning out to "all attendee lines" would
mark — and, under option B, allocate refund money to — lines whose payment was
never refunded.

There is currently **no per-line payment reference** (the `payment_id` lives
attendee-level in the encrypted pii_blob), so the data needed to scope the
fan-out correctly does not exist yet. Options, in rough order of correctness:

- **(Best) Add a per-line order marker — but NOT the raw payment reference
  (review #3).** `listing_attendees` is a plaintext table that backups dump,
  whereas the provider `payment_id` is deliberately kept in the *encrypted* PII
  blob. Putting the raw reference here would leak it. Store a **non-sensitive
  internal order/checkout id** (or an encrypted value with a blind index)
  instead, captured at creation, so a refund can mark exactly the lines sharing
  that order. This is a second schema change — arguably the *right* foundation
  for refunds, but larger scope; call it out as its own decision. **If chosen,
  the marker is subject to the same read/write sweep as `refunded_amount`
  (review):** every per-line SELECT (§5) and the merge loader+insert (§5c/§14)
  must carry it, or a merged booking loses its order key and falls back to the
  exact attendee-level ambiguity this option fixes.
- **Restrict refunds to order-level for un-merged attendees, and block/flag
  refunds on merged attendees** until a per-line marker exists.
- **Narrow predicate without new columns:** only fan out across lines that were
  not brought in by a merge — but there's no reliable flag for that today, so
  this is fragile and not recommended.
- **Keep single-line marking** (status quo of the boolean `refunded`) and accept
  the under-report, documented per §8.5 — the smallest scope, and honest if
  paired with the "approximate" labelling.

Allocation (when a marker exists): split the provider's returned total across the
covered lines with `allocateByLargestRemainder` (`checkout-pricing.ts`) — **but
not weighted by the current `price_paid` (review #2)**. For balance-paid
reservations, `settleAttendeeBalance` folds the later balance payment into the
earliest line's `price_paid`, so weighting by today's `price_paid` would shovel
too much of the refund onto that line. The weight must be the **per-line amount
that the refunded payment actually charged**, captured at checkout (the same
per-line snapshot the order marker would carry) — not the mutated `price_paid`.
This is another reason the per-line marker should record the charged amount, not
just an id.

**This is the one genuinely open design question in the feature** — it needs a
decision (per-line marker vs. accept-and-document) before the fan-out is built.

### 10c. Partial refunds (future)

The `amount` parameter on `markRefunded` already accommodates a partial value;
no schema change needed when partial-refund support arrives.

**Plan:** 10a is required (option B chosen) and ships with the core feature —
it's the difference between `refunded_amount` meaning "money returned" vs. "ticket
revenue on one line". 10b (the fan-out scoping) is the remaining open
sub-decision; resolve it (per-line marker vs. accept-and-document) before
building the fan-out, but 10a does not depend on it.

---

## 11. Alternative: column on `attendees` (the literal request)

If we instead put `refunded_amount` on the **`attendees`** table (order-level
total refunded):

- **Schema**: add `["refunded_amount", "INTEGER NOT NULL DEFAULT 0"]` to the
  `attendees` table block; migration `requires.columns.attendees`.
- **Semantics**: it becomes an order-level accumulator. `markRefunded` (which
  is per-line) must `UPDATE attendees SET refunded_amount = refunded_amount +
  (that line's price_paid) WHERE id = ?` — now a two-table write, and
  **no longer idempotent** (re-running double-counts). You'd need a guard so a
  line is only added once (e.g. only add when the line flips 0→1, which means
  reading the line first or doing it in one conditional statement).
- **Reads**: `ATTENDEE_COLS` in `queries.ts` (not `EA_COLS`) gains the column;
  `getAttendeeBalanceState`-style selects can read it directly without a join.
- **Type**: `Attendee.refunded_amount` (number), plus it would belong on
  `AttendeeWithBookings` rather than `ListingAttendeeRow`.
- **Merge**: when merging attendees you'd sum `refunded_amount` across the two
  attendees rather than carrying it on the moved booking rows.
- **Downside**: it fights the per-line `refunded` flag (you can have one line
  refunded but a single attendee-level number), loses per-line granularity, and
  makes the write non-idempotent. This is why §0 recommends `listing_attendees`.

Everything else (UI, i18n, tests, currency formatting) is the same.

---

## 12. i18n

Add one key (both the badge label and "Not refunded" already exist):

- `src/locales/en/admin.json`: add
  `"admin.attendees.amount_refunded": "Amount Refunded:"` (next to the existing
  `admin.attendees.amount_paid` / `refund_status` keys).
- Add the same key to any other locale files under `src/locales/*/admin.json`
  if the project keeps locales in sync (check what exists; only `en` may be
  present).

No new keys are needed if §8 is limited to reusing existing labels, but a
dedicated "Amount Refunded" label reads best.

---

## 13. CSV / export

`src/features/admin/attendees-csv.ts` → `standardAttendeeColumns` currently has
`price_paid` and `transaction_id` but **no refund column**. Add a refunded
column so exports carry it:

```ts
{ header: t("csv.col.amount_refunded"), value: (a) => formatPrice(String(a.refunded_amount)) },
```

(Reuse the local `formatPrice` helper, which is `toMajorUnits(parseInt(...))`.)
Add `csv.col.amount_refunded` to `src/locales/en/csv.json` (or wherever the
`csv.col.*` keys live). This column is shared with the calendar export, so it
appears there too — confirm that's desired; if not, add it only to the
attendee-specific column block instead of `standardAttendeeColumns`.

---

## 14. Merge — `src/shared/merge/attendee-merge.ts` (REQUIRED, not optional)

The merge runs against live data regardless of whether we "opt in" to merge
support, so once the column exists these two changes are **required** to avoid
silent data loss (review #6) — not the "recommended" niceties the first draft
called them:

1. **Insert** — `bookingInsertStatement` copies a source booking line to the
   target; add `refunded_amount: booking.refunded_amount` to the
   `insert("listing_attendees", {...})` payload. Without it, every moved/replaced
   refunded line is re-inserted at the column **default 0**, silently zeroing the
   recorded refund on each merge.
2. **Loader (§5c)** — the insert reads `booking.refunded_amount`, which is only
   populated if `loadAttendeeBookings` selects the column. Land the loader and
   insert together; cover with a merge test (§15g) that moves a refunded line and
   asserts the amount survives.

**Duplicate detection (review #2) — required under option B.**
`buildBookingDiffItems` classifies a source booking as a `duplicate` (and skips
it) when it matches the target on `quantity`, `price_paid`, `checked_in`,
`refunded`. Under **option A** `refunded_amount` is derived from
`price_paid`+`refunded`, so adding it changes nothing. Under **option B** it is
*not* derived (fees, balance refunds, and the backfill make it diverge), so two
lines equal on the four fields can differ on `refunded_amount` — and skipping the
source would silently drop that amount. Therefore: add `refunded_amount` to the
comparison whenever option B is in play (harmless under A, so just include it).

---

## 15. Tests

Follow the existing patterns (BDD + `@std/expect`, helpers from `#test-utils`).
100% coverage is required and must be **deterministic** (in-process unit tests,
not just subprocess/e2e coverage — AGENTS.md).

### 15a. DB write — new/extended unit test for `markRefunded`

In a DB-backed test (see `test/lib/db/auto-cache-invalidation.test.ts` which
already calls `markRefunded`):

- Create a paid attendee/line with a known `price_paid` (e.g. 500).
- Call `markRefunded(id, listingId, startAt)` (fallback form).
- Assert the `listing_attendees` row has `refunded = 1` **and**
  `refunded_amount = 500` (read it back via a query).
- Idempotency: call `markRefunded` again, assert `refunded_amount` is still 500
  (not doubled) — this is the mutation-resistant assertion that proves
  `= price_paid` (copy) vs `+= price_paid` (accumulate).
- With the `amount` arg: `markRefunded(id, listingId, startAt, 200)` sets
  `refunded_amount = 200`.
- **Row identity:** create the *same* attendee on the *same* listing for **two
  different dates**, call `markRefunded` for one date, and assert only that row
  is refunded (the other stays `refunded = 0, refunded_amount = 0`). This is the
  mutation-resistant test for the `start_at` filter (§6).

### 15b. Route integration — extend `test/lib/server-refunds.test.ts`

After a successful single refund (and after `refund-all`), assert the
attendee's persisted `refunded_amount` equals the recorded amount — the line's
`price_paid` under option A, or the stubbed provider amount under option B (§10a).
The file already has `createPaidTestAttendee`, `submitRefund`, `submitRefundAll`,
and a `stripePaymentProvider.refundPayment` stub — extend the success assertions
to read the row back (or re-fetch via `getAttendeeRaw`/`getAttendeesByTokens`)
and check `refunded_amount`. If §10b ships, add a **multi-line** case: an
attendee with two listings on one payment, refund once, assert **both** lines
end up `refunded` with the amount allocated across them.

### 15c. Refresh-payment path — `test/lib/server-attendees.test.ts`

The refresh-payment tests (around the `isPaymentRefunded` stubs) should assert
`refunded_amount` is set when the provider reports a refund.

### 15d. Decryption / type mapping

A `decryptAttendeeFields` test (or wherever `pii.ts` is covered) asserting
`refunded_amount` is numeric and 0 when unpaid (`paidListing = false`).

### 15e. Display

- `PaymentDetails` template test: refunded attendee with `refunded_amount > 0`
  renders the formatted amount; non-refunded attendee does not.
- If §8c/§8d are done, extend `test/lib/attendee-table.test.ts` /
  `attendee-form-model.test.ts` accordingly.

### 15f. CSV

Extend the attendees-csv test to assert the new column header + a refunded
attendee's formatted value.

### 15g. Merge

Extend `test/lib/attendee-merge.test.ts` to assert a moved booking line keeps
its `refunded_amount`.

### 15h. Factories — `test/test-utils/factories.ts`

Add `refunded_amount: 0` to `testAttendee()` (the `Attendee` factory). Check
`createPaidTestAttendee` / any `listing_attendees` insert helpers in
`#test-utils` set the column (the DEFAULT 0 covers inserts that omit it).
`WebhookAttendee` factory (`makeTestAttendee`) only needs it if §16 is done.

---

## 16. Webhook payload (optional)

`src/shared/webhook.ts` builds the outbound `WebhookAttendee` (it already
includes `price_paid` and `payment_id`, but **not** `refunded`). If consumers
should see refunds, add `refunded_amount` (and probably `refunded`) to the
webhook attendee type + builder + `makeTestAttendee` factory + webhook docs
(`src/docs/webhooks.ts`). Out of scope unless explicitly wanted — flag it.

---

## 17. File-by-file checklist

| File | Change | Required? |
| --- | --- | --- |
| `src/shared/db/migrations/schema.ts` | Add column to `listing_attendees`; update `LATEST_UPDATE` | ✅ |
| `src/shared/db/migrations/2026-06-21_attendee_refunded_amount.ts` | New migration **+ `after()` backfill** of legacy refunded rows (§18) | ✅ |
| `src/shared/db/migrations.ts` | Import + append to `MIGRATIONS` | ✅ |
| `src/shared/db/attendee-types.ts` | `ListingAttendeeRow.refunded_amount` | ✅ |
| `src/shared/types.ts` | `Attendee.refunded_amount` | ✅ |
| `src/shared/db/attendees/queries.ts` | `EA_COLS`, `ATTENDEE_LEFT_JOIN_SELECT`, `getAttendeesByTokens` | ✅ |
| `src/shared/db/attendees/update.ts` | `markRefunded` gains `startAt` (single-row target, §6) + `amount`; stores the **provider amount** (option B), `price_paid` only for SumUp/backfill | ✅ |
| `src/shared/db/attendees/pii.ts` | Map `refunded_amount` in `decryptAttendeeFields` | ✅ |
| `src/shared/db/attendees/atomic-update.ts` | `loadExistingLines` SELECT must add `refunded_amount` (§5d) | ✅ |
| `src/features/admin/attendees-edit.ts` | Add column to refresh-context select | ✅ |
| `src/ui/templates/admin/attendees.tsx` | Show amount in `PaymentDetails` (+ refund confirm) | ✅ |
| `src/locales/en/admin.json` | `admin.attendees.amount_refunded` | ✅ |
| `test/test-utils/factories.ts` | `refunded_amount: 0` in `testAttendee` | ✅ |
| Tests (§15) | New/extended coverage | ✅ |
| `src/features/admin/attendees-merge.ts` | `loadAttendeeBookings` must SELECT `refunded_amount` (§5c) | ✅ (merge runs regardless) |
| `src/shared/merge/attendee-merge.ts` | Insert copies `refunded_amount`; add to dedup compare under option B (§14) | ✅ (else merges zero it) |
| `src/features/admin/attendees-csv.ts` + csv locale | Export column (§13; label per provenance, §18) | ✅ (DoD requires it) |
| Provider layer (§10a): `*-provider.ts` + `square.ts` lower layer + Stripe `retrievePaymentIntent` narrowing + `isPaymentRefunded` + all `refundPayment`/`isPaymentRefunded` callers (incl. `webhooks.ts`) | Record provider's **actual** refunded amount (option B) | ✅ (owner-chosen) |
| Refund routes + maybe per-line payment marker (§10b) | Fan out an order-level refund across covered lines — **open sub-decision** | 🔶 decision required (§10b) |
| `src/features/admin/attendee-form-model.ts` + `attendee-form.tsx` | Per-line amount in bookings table | ⭕ optional |
| `src/shared/columns/attendee-columns.ts` | Amount in list status badge | ⭕ optional |
| `src/shared/webhook.ts` (+docs, factory) (§16) | Webhook payload | ⭕ future |

✅ = required for a correct, tested feature. 🔶 = recommended for *accuracy* —
without these, `refunded_amount` is ticket-only/approximate (see §8.5); decide
explicitly. ⭕ = scope choices.

---

## 18. Edge cases & invariants

- **Legacy already-refunded rows — backfill is recommended (PR review).** New
  rows default to `refunded_amount = 0`, so every historically refunded line
  (`refunded = 1`) would report **0** in the admin UI and CSV — under-reporting
  past refunds. Crucially this **cannot self-heal**: `handleRefreshPayment` only
  calls `markRefunded` when `!attendee.refunded`
  (`attendees-edit.ts:87`), so an already-refunded row is never revisited.
  Therefore the migration should backfill in its `after()` hook:

  ```sql
  UPDATE listing_attendees SET refunded_amount = price_paid
  WHERE refunded = 1 AND refunded_amount = 0
  ```

  Caveat: the backfill inherits the §8.5 inaccuracies (it uses `price_paid`, so
  fees are excluded and balance-paid reservations are over-stated) — but for
  *historical* rows the provider amount is not retrievable cheaply, so
  `price_paid` is the best available estimate. Either way, **do not silently
  leave legacy rows at 0** — that is the one option review explicitly flagged as
  wrong.
- **Provenance — we can't tell exact from approximate rows (review).** Once the
  column is just a number, three kinds of value are indistinguishable: provider-
  exact (Stripe/Square new refunds), SumUp fallback (`price_paid`), and the
  historical backfill (`price_paid`). If the UI/CSV shows a plain "Amount
  Refunded", a fee/reservation backfill row looks as authoritative as an exact
  one. Two ways to resolve, **decide explicitly**:
  - **(a) Store provenance** — a small `refunded_amount_source` marker (e.g.
    `'provider' | 'estimate'`) set when the row is written, so the UI can label
    estimates and exact values differently. Cleanest; one extra small column.
  - **(b) Label everything as approximate** — simplest, but loses the accuracy
    win of option B for the rows that *are* exact.
  Recommendation: (a) — it's cheap and preserves option B's value. (Note this is
  a *different* flag from the abandoned `NOT NULL`/`NULL` "unknown" idea: the
  amount stays a non-null integer; the marker only records how it was derived.)
- **Unpaid listings**: `refunded_amount` suppressed to 0 alongside `refunded`
  (the `paidListing` gate in `pii.ts`).
- **Balance-paid reservations — the `refunded` *flag* is the real problem
  (review).** Option B records the right *amount* (the provider's true deposit
  refund), but `markRefunded` still sets `refunded = 1` on the line — and the
  rest of the app reads that boolean as **fully refunded**: `checkin.ts:101`
  filters out `!attendee.refunded` and shows "Cannot check in refunded tickets".
  So refunding only the original deposit of a reservation whose balance was later
  paid would record the correct (partial) amount **but wrongly mark the booking
  fully refunded**, blocking check-in for someone who still paid most of the
  order. Recording the amount accurately is *not* enough here. This path must
  either be **excluded** (don't allow a deposit-only refund to flip `refunded`)
  or modeled as a **partial refund** (a `refunded` state that means "partially
  refunded, still valid" — i.e. the boolean is insufficient and may need to
  become a status). **This is a real gap to resolve**, related to but separate
  from the §10b fan-out; flag it as a decision, don't call it "correct".
- **Free bookings** (`price_paid = 0`): refunding sets `refunded = 1`,
  `refunded_amount = 0` — correct (£0 refunded).
- **Idempotency**: the write **copies** the recorded amount (the provider amount,
  or the `price_paid` fallback) rather than accumulating, so repeated
  `markRefunded` calls are stable. Tested in §15a.
- **Aggregates untouched**: confirm `listings.income` / capacity are unchanged
  by a refund (they already are; `refunded_amount` writes don't fire the
  aggregate trigger). A regression test asserting `income` is unaffected by a
  refund is cheap insurance.

---

## 19. Rollout / safety

1. Additive `NOT NULL DEFAULT 0` `ADD COLUMN` — safe online, no rewrite, no
   downtime, no FK churn.
2. Fresh DBs get it via `applySchemaChanges()` on first boot; existing DBs get
   it via the named migration. The migration's generated `verify()` fails the
   boot loudly if the column didn't apply.
3. Reversible: dropping the column (if ever needed) only loses the recorded
   amounts; the `refunded` flag is independent.
4. Backups already round-trip new columns (§3d) — verify once in testing.

---

## 20. Definition of done

- [ ] Migration applies on a populated DB; `verify()` passes; `SCHEMA_HASH`
      bumped; `LATEST_UPDATE` updated; legacy refunded rows backfilled (§18).
- [ ] `markRefunded` sets `refunded` + `refunded_amount` atomically and
      idempotently (copy semantics). The refund routes pass the **provider
      amount** (option B); the optional `amount` param keeps the signature
      compatible, but callers do change (see §6).
- [ ] `Attendee.refunded_amount` populated through **every** read path (§5a–5e,
      including `attendees-merge.ts` and `atomic-update.ts` loaders); type checks.
- [ ] Amount shown in the admin payment details panel — as the **sum** across
      the attendee's booking lines, not a single flattened row (§8a).
- [ ] Merge loader+insert (§5c/§14) and CSV carry it.
- [ ] **Provenance decided (§18):** add a `refunded_amount_source`
      (provider/estimate) marker, or label all amounts approximate — so exact and
      fallback rows aren't shown identically.
- [ ] **Deposit-only / partial refunds decided (§18):** a deposit-only refund of
      a balance-paid reservation must NOT flip the `refunded` boolean to "fully
      refunded" (it blocks check-in — `checkin.ts:101`). Either exclude that path
      or model partial refunds (the boolean may need to become a status).
- [ ] **Amount source = option B (decided):** widen `refundPayment` **and**
      `isPaymentRefunded` across all 3 providers, stop the lower Stripe
      (`retrievePaymentIntent` narrowing) and Square (`square.ts`) layers
      discarding the amount, and update **every** caller — incl. `webhooks.ts`
      auto-refund (`.ok`) and `tryRefund` (`.refunded`). `price_paid` remains the
      fallback only for SumUp and the historical backfill.
- [ ] **Multi-line fan-out decided (§10b):** per-line payment marker vs.
      accept-and-document. (The one remaining open question — don't ship the
      fan-out without it.)
- [ ] Tests added per §15; `deno task test:coverage` is 100% and deterministic;
      `deno task test:quality-audit` clean for new tests.
- [ ] `deno task precommit` (typecheck, `lint:ci`, tests, `cpd` at 0%) passes.
- [ ] PR notes the webhook auto-refund callers (§9 — `.ok`/`.refunded` under
      option B) and records the §10b decision.
