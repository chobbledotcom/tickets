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

There are **two candidate values** for `refunded_amount`:

- **(A) the line's `price_paid`** — zero interface churn, but it is only the
  *ticket* portion and diverges from the money actually returned in three real
  configurations (booking fees, balance-paid reservations, multi-line orders —
  see **§8.5**, the accuracy section, which exists because of PR review
  feedback).
- **(B) the provider's actual refunded amount** — the true money moved, but it
  requires widening the provider interface (§10).

Because the divergences in §8.5 are real and not rare, **the recommended source
of truth is (B), the provider's actual amount, with (A) `price_paid` as the
fallback** when a provider can't report an amount (SumUp) or for the historical
backfill. Read §8.5 and §10 before locking this in — it is the single most
important correctness decision in the feature, and it shifted from the original
draft after review.

---

## 2. Design decisions

1. **Column**: `refunded_amount INTEGER NOT NULL DEFAULT 0` on
   `listing_attendees`. Minor units, never null, defaults to 0 (so existing
   rows and non-refunded rows read as 0 — "nothing refunded").
2. **Value written**: `markRefunded(attendeeId, listingId, amount?)` sets
   `refunded = 1` and `refunded_amount = amount`, in a single atomic UPDATE so
   the flag and amount can never drift. The `amount` is:
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
);
```

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
 * Mark a booking line refunded and record the refunded amount. The amount
 * defaults to what was paid for the line (the only case we support today —
 * full refunds via provider.refundPayment); a caller may pass a smaller
 * amount once partial refunds are supported.
 */
export const markRefunded = async (
  attendeeId: number,
  listingId: number,
  amount?: number,
): Promise<void> => {
  await execute(
    amount === undefined
      ? "UPDATE listing_attendees SET refunded = 1, refunded_amount = price_paid WHERE attendee_id = ? AND listing_id = ?"
      : "UPDATE listing_attendees SET refunded = 1, refunded_amount = ? WHERE attendee_id = ? AND listing_id = ?",
    amount === undefined
      ? [attendeeId, listingId]
      : [amount, attendeeId, listingId],
  );
};
```

Notes:
- `refunded_amount = price_paid` copies the column in-SQL, so it always equals
  exactly what was paid for that line — no read-then-write race.
- No JSCPD concern: this is one helper, not duplicated logic. If the two
  branches trip the duplication check, fold them into one parameterised
  statement builder.
- The **signature is backward-compatible** (the `amount` param is optional), but
  whether callers *change* depends on the §2 option:
  - **Option A (fallback):** callers keep `markRefunded(id, listingId)` and get
    `refunded_amount = price_paid` for free.
  - **Option B (provider amount, recommended):** the refund routes
    (`attendee-refunds.ts` single + bulk, and the refresh path — see §10) **must
    pass the amount**: `markRefunded(id, listingId, providerAmount)`. Do not
    assume callers are unchanged under option B (the §20 DoD reflects this).

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
show the refunded amount next to the existing refund-status badge:

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

`adminRefundAttendeePage` warns "This will issue a full refund". Optionally
show the exact amount that will be refunded (`attendee.price_paid`) so the
operator sees it before confirming. Pure copy/markup change.

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

**Implications for the design:**

- Cases 1 and 2 are why **option B (record the provider's actual amount, §10) is
  the recommended source of truth.** The provider's refund response is the one
  number that is correct in all three cases — it is exactly the money returned.
- Case 3 needs a **write-fan-out** fix independent of which amount we store: when
  an order-level refund succeeds, mark every line that payment covered, not just
  the operator's line. **Scoping that fan-out correctly is the open question** —
  attendee-level `payment_id` is insufficient because a merge can leave one
  attendee holding lines from several payments (see §10b). It likely needs a new
  per-line payment/order marker, or the smaller-scope "accept + document"
  choice. See §10b for the options and recommendation.
- If we ship option A first anyway (e.g. to avoid provider churn), the plan must
  **document `refunded_amount` as "ticket revenue refunded, fee-exclusive, and
  approximate for balance-paid reservations"** in the column comment, the admin
  UI, and the CSV header — so no one reads it as "total returned to the
  customer".

**Recommendation:** treat §8.5 as a gating decision. My recommendation is
option B + the case-3 fan-out; if that is too much scope now, ship option A with
the explicit "ticket-only / approximate" labelling and a follow-up issue for B.

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
`price_paid` is wrong in common configurations, so it is now a **tracked
decision**, not a nice-to-have.

### 10a. Surface the provider amount (option B)

Widen the provider interface so the real refunded amount reaches `markRefunded`.
This is **two layers**, not just the provider wrapper:

1. **Interface + wrappers** — `PaymentProvider.refundPayment(ref):
   Promise<boolean>` → `Promise<{ ok: boolean; amount?: number }>` (or
   `number | null`). Update `stripe-provider.ts`, `square-provider.ts`,
   `sumup-provider.ts`.
2. **Lower API layers** (the easy-to-miss part):
   - **Stripe** — `src/shared/stripe.ts:322` already returns `Stripe.Refund`
     (carrying `.amount`), so only the provider wrapper needs to stop discarding
     it. ✅ no lower-layer change.
   - **Square** — `src/shared/square.ts:608` *computes* the refund amount
     (`payment.amountMoney.amount`) but its `withClient` callback returns only
     `true`, and the REST adapter (`refunds.refundPayment`, ~`:343`) returns
     `{}`. **`square.ts` (and its tests) must be changed to return the amount**;
     changing `square-provider.ts` alone leaves Square falling back to
     `price_paid`.
   - **SumUp** — returns boolean only → `amount` undefined → fall back to
     `price_paid` (acceptable; documented).
3. **All callers must read the new shape** (see also §9):
   - `attendee-refunds.ts` single (`:101-112`) + bulk (`:160-163`) — branch on
     `.ok`, pass `.amount` into `markRefunded(id, listingId, amount)`.
   - `webhooks.ts:239` auto-refund — branch on `.ok` (no amount stored).
4. **Refresh path needs the amount too (review #3).** `handleRefreshPayment`
   does **not** call `refundPayment`; it calls `isPaymentRefunded(ref)` →
   boolean, then `markRefunded`. For refunds made directly in Stripe/Square and
   then refreshed in-app, widening only `refundPayment` still leaves this path on
   the `price_paid` fallback. To record the provider's actual amount here,
   `isPaymentRefunded` must also return the refunded amount (e.g.
   `Promise<{ refunded: boolean; amount?: number }>` or a companion
   `getRefundedAmount(ref)`), and `handleRefreshPayment` must pass it through.
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

- **(Best) Add a per-line payment/order marker.** Store the
  payment reference (or an order/checkout id) on `listing_attendees` at creation,
  so a refund can mark exactly the lines that share the refunded reference. This
  is a second schema change — arguably the *right* foundation for refunds, but
  larger scope; call it out as its own decision.
- **Restrict refunds to order-level for un-merged attendees, and block/he-flag
  refunds on merged attendees** until a per-line marker exists.
- **Narrow predicate without new columns:** only fan out across lines that were
  not brought in by a merge — but there's no reliable flag for that today, so
  this is fragile and not recommended.
- **Keep single-line marking** (status quo of the boolean `refunded`) and accept
  the under-report, documented per §8.5 — the smallest scope, and honest if
  paired with the "approximate" labelling.

Allocation (when a marker exists and option B is used): split the provider's
returned total across the covered lines by `price_paid` weight using
`allocateByLargestRemainder` (`checkout-pricing.ts`); under option A each covered
line records its own `price_paid`.

**This is the one genuinely open design question in the feature** — it needs a
decision (per-line marker vs. accept-and-document) before the fan-out is built.

### 10c. Partial refunds (future)

The `amount` parameter on `markRefunded` already accommodates a partial value;
no schema change needed when partial-refund support arrives.

**Recommendation:** do 10a + 10b together with the core feature — they are the
difference between `refunded_amount` meaning "money returned" vs. "ticket
revenue on one line". If scope must shrink, ship option A (§2) with the explicit
"ticket-only/approximate" labelling from §8.5 and open a follow-up for 10a/10b.

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

## 14. Merge — `src/shared/merge/attendee-merge.ts`

`bookingInsertStatement` copies a source booking line to the target; add
`refunded_amount: booking.refunded_amount` to the `insert("listing_attendees",
{...})` payload so a moved/replaced line keeps its refunded amount.

> **Pairs with §5c.** This insert reads `booking.refunded_amount`, which is only
> populated if `loadAttendeeBookings` in `attendees-merge.ts` selects the
> column. Without that SELECT, `booking.refunded_amount` is `undefined` and the
> insert violates the `NOT NULL` constraint (or silently drops the amount). Land
> the loader change (§5c) and this insert change together, and cover it with a
> merge test (§15g) that moves a refunded line and asserts the amount survives.

Optionally include `refunded_amount` in the duplicate-detection comparison in
`buildBookingDiffItems` (currently compares `quantity`, `price_paid`,
`checked_in`, `refunded`). Since `refunded_amount` is derived from
`price_paid`+`refunded`, two lines equal on those three will almost always be
equal on `refunded_amount` too — adding it is harmless and precise but not
strictly required. Include for completeness.

---

## 15. Tests

Follow the existing patterns (BDD + `@std/expect`, helpers from `#test-utils`).
100% coverage is required and must be **deterministic** (in-process unit tests,
not just subprocess/e2e coverage — AGENTS.md).

### 15a. DB write — new/extended unit test for `markRefunded`

In a DB-backed test (see `test/lib/db/auto-cache-invalidation.test.ts` which
already calls `markRefunded`):

- Create a paid attendee/line with a known `price_paid` (e.g. 500).
- Call `markRefunded(id, listingId)`.
- Assert the `listing_attendees` row has `refunded = 1` **and**
  `refunded_amount = 500` (read it back via a query).
- Idempotency: call `markRefunded` again, assert `refunded_amount` is still 500
  (not doubled) — this is the mutation-resistant assertion that proves
  `= price_paid` (copy) vs `+= price_paid` (accumulate).
- With the optional `amount` arg: `markRefunded(id, listingId, 200)` sets
  `refunded_amount = 200`.

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
| `src/shared/db/attendees/update.ts` | `markRefunded` sets `refunded_amount = price_paid` | ✅ |
| `src/shared/db/attendees/pii.ts` | Map `refunded_amount` in `decryptAttendeeFields` | ✅ |
| `src/features/admin/attendees-edit.ts` | Add column to refresh-context select | ✅ |
| `src/ui/templates/admin/attendees.tsx` | Show amount in `PaymentDetails` (+ refund confirm) | ✅ |
| `src/locales/en/admin.json` | `admin.attendees.amount_refunded` | ✅ |
| `test/test-utils/factories.ts` | `refunded_amount: 0` in `testAttendee` | ✅ |
| Tests (§15) | New/extended coverage | ✅ |
| `src/features/admin/attendees-merge.ts` | **`loadAttendeeBookings` must SELECT `refunded_amount`** (§5c) | ✅ if merge carries it |
| `src/shared/merge/attendee-merge.ts` | Carry `refunded_amount` on moved lines (insert) | ⭕ recommended (pairs with row above) |
| `src/features/admin/attendees-csv.ts` + csv locale | Export column (label "ticket-only/approx" if option A — §8.5) | ⭕ recommended |
| Provider layer (§10a): `*-provider.ts` + `square.ts` lower layer + `isPaymentRefunded` + all `refundPayment` callers (incl. `webhooks.ts`) | Record provider's **actual** refunded amount | 🔶 recommended for correctness (§8.5) |
| Refund routes + maybe per-line payment marker (§10b) | Fan out an order-level refund across covered lines — **open design question** | 🔶 decision required (§8.5/§10b) |
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
  `price_paid` is the best available estimate. The alternative is an explicit
  "unknown" sentinel (e.g. leave a separate `refunded_amount_known` flag / use
  `NULL`), but that complicates the `NOT NULL` column and every reader; the
  pragmatic choice is the `price_paid` backfill **plus** the "approximate"
  labelling from §8.5. Either way, **do not silently leave legacy rows at 0** —
  that is the one option review explicitly flagged as wrong.
- **Unpaid listings**: `refunded_amount` suppressed to 0 alongside `refunded`
  (the `paidListing` gate in `pii.ts`).
- **Balance-paid reservations (§8.5 case 2)**: refunding the stored deposit
  `payment_id` returns only the deposit, but `price_paid` was inflated by
  `settleAttendeeBalance`. With option A, `refunded_amount` over-reports here;
  option B (provider amount) records the true deposit refund. Call this out
  wherever `refunded_amount` is shown if option A ships first.
- **Free bookings** (`price_paid = 0`): refunding sets `refunded = 1`,
  `refunded_amount = 0` — correct (£0 refunded).
- **Idempotency**: `= price_paid` (copy, not accumulate) keeps repeated
  `markRefunded` calls stable. Tested in §15a.
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
      idempotently (copy semantics). **Under option B the refund routes pass the
      provider amount** — callers change, the signature stays compatible (the
      "unchanged callers" claim only holds for option A; see §6).
- [ ] `Attendee.refunded_amount` populated through **every** read path (§5a–5e,
      including `attendees-merge.ts` and `atomic-update.ts` loaders); type checks.
- [ ] Amount shown in the admin payment details panel.
- [ ] (Recommended) merge loader+insert (§5c/§14) and CSV carry it.
- [ ] **Amount source decided (§2/§8.5/§10):** option A (`price_paid`, with
      "ticket-only/approximate" labelling) or option B (provider amount — widen
      `refundPayment` *and* `isPaymentRefunded`, update Square's `square.ts`
      lower layer, and all callers incl. `webhooks.ts` to read `.ok`).
- [ ] **Multi-line fan-out decided (§10b):** per-line payment marker vs.
      accept-and-document. (Open question — don't ship the fan-out without it.)
- [ ] Tests added per §15; `deno task test:coverage` is 100% and deterministic;
      `deno task test:quality-audit` clean for new tests.
- [ ] `deno task precommit` (typecheck, `lint:ci`, tests, `cpd` at 0%) passes.
- [ ] PR notes the webhook auto-refund caller (§9, must read `.ok` under option
      B) and records the §8.5/§10b decisions.
