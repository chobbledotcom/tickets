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
| Amount paid for a booking line | `listing_attendees.price_paid` | `INTEGER` minor units | Trigger-summed into `listings.income`. |
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
amount is *available at Stripe/Square* but *not* at the interface today (see
the optional enhancement in §10). For v1 we record the line's `price_paid` as
the refunded amount, which is correct for the full refunds we support.

---

## 2. Design decisions

1. **Column**: `refunded_amount INTEGER NOT NULL DEFAULT 0` on
   `listing_attendees`. Minor units, never null, defaults to 0 (so existing
   rows and non-refunded rows read as 0 — "nothing refunded").
2. **Value written**: when a line is marked refunded, set
   `refunded_amount = price_paid` (what was paid for that line). Implemented as
   a single atomic UPDATE inside `markRefunded` so it can never drift from the
   `refunded` flag.
3. **Idempotency**: re-running `markRefunded` is harmless — it re-sets
   `refunded = 1, refunded_amount = price_paid`. (The routes already guard
   against double-refunding at the provider via the `refunded` check.)
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

### 5c. Anywhere else selecting `listing_attendees` per-line columns

Grep check: `rg "checked_in, refunded, price_paid"` and
`rg "ea\\.refunded"` — update every explicit column list that already pulls
`refunded`/`price_paid` to also pull `refunded_amount`. Known sites are 5a/5b;
confirm none were missed.

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
- All existing callers (`attendee-refunds.ts` single + bulk,
  `attendees-edit.ts` refresh) keep calling `markRefunded(id, listingId)`
  unchanged and get `refunded_amount = price_paid` for free.

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

## 9. Webhook auto-refund path (explicitly out of scope)

`src/features/api/webhooks.ts:239` refunds *untrusted/invalid* checkout
sessions that never become an attendee. There is no `listing_attendees` row, so
there is nothing to set `refunded_amount` on. No change. Call this out in the
PR description so it isn't mistaken for a gap.

(If we ever want to ledger those defensive refunds, that's a separate
"refunds log" table, not this column.)

---

## 10. Optional enhancement: record the *provider's actual* refunded amount

Today the recorded amount = the line's `price_paid`. That is exactly right for
full refunds of single-line orders. Two cases where it can diverge from the
true money moved:

1. **Multi-line orders on one payment.** `provider.refundPayment(payment_id)`
   refunds the *entire* Stripe/Square payment (all lines), but the single-refund
   route marks only the one line the operator was on. So `refunded_amount` for
   that line under-reports the actual refund. (This is a pre-existing modelling
   quirk of `refunded` too, not introduced here.)
2. **Partial refunds**, if ever supported.

To record the real number we'd widen the provider interface:

- `PaymentProvider.refundPayment(ref): Promise<boolean>` →
  `Promise<{ ok: boolean; amount?: number }>` (or `number | null`).
- Stripe already has it: `s.refunds.create(...)` returns `Stripe.Refund.amount`
  (`src/shared/stripe.ts`). Square's refund response carries `amount_money`.
  SumUp returns boolean only — fall back to `price_paid`.
- Pass the returned amount into `markRefunded(id, listingId, amount)`.

**Recommendation: defer.** It touches all three providers
(`stripe-provider.ts`, `square-provider.ts`, `sumup-provider.ts`) and a large
number of provider tests/stubs (see the ~100 `refundPayment` stub call sites in
`test/`). v1 = `price_paid`, which is correct for the full-refund flows we
actually ship. Add a TODO referencing this section. For the multi-line
single-refund quirk, a cheaper interim fix is to mark **all** of the payment's
lines refunded (loop the attendee's `listing_attendees` rows sharing that
payment) — note as a follow-up, don't bundle it here.

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
attendee's persisted `refunded_amount` equals the line's `price_paid`. The file
already has `createPaidTestAttendee`, `submitRefund`, `submitRefundAll`, and a
`stripePaymentProvider.refundPayment` stub — extend the success assertions to
read the row back (or re-fetch via `getAttendeeRaw`/`getAttendeesByTokens`) and
check `refunded_amount`.

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
| `src/shared/db/migrations/2026-06-21_attendee_refunded_amount.ts` | New migration | ✅ |
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
| `src/shared/merge/attendee-merge.ts` | Carry `refunded_amount` on moved lines | ⭕ recommended |
| `src/features/admin/attendees-csv.ts` + csv locale | Export column | ⭕ recommended |
| `src/features/admin/attendee-form-model.ts` + `attendee-form.tsx` | Per-line amount in bookings table | ⭕ optional |
| `src/shared/columns/attendee-columns.ts` | Amount in list status badge | ⭕ optional |
| Provider interface (§10) | Real provider refund amount | ⭕ future |
| `src/shared/webhook.ts` (+docs, factory) (§16) | Webhook payload | ⭕ future |

✅ = required for a correct, tested feature. ⭕ = scope choices.

---

## 18. Edge cases & invariants

- **Non-refunded / legacy rows** read `refunded_amount = 0` (DEFAULT + COALESCE
  on left joins). No backfill needed — historically refunded rows simply show 0
  until re-refreshed, which is acceptable (we never recorded the amount before).
  If a backfill is wanted, a one-off `UPDATE listing_attendees SET
  refunded_amount = price_paid WHERE refunded = 1 AND refunded_amount = 0`
  could run in the migration's `after()` hook — **decide explicitly**; default
  is no backfill.
- **Unpaid listings**: `refunded_amount` suppressed to 0 alongside `refunded`
  (the `paidListing` gate in `pii.ts`).
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
      bumped; `LATEST_UPDATE` updated.
- [ ] `markRefunded` sets `refunded_amount = price_paid` atomically and
      idempotently; all existing callers unchanged.
- [ ] `Attendee.refunded_amount` populated through every read path; type checks.
- [ ] Amount shown in the admin payment details panel.
- [ ] (Recommended) merge + CSV carry it.
- [ ] Tests added per §15; `deno task test:coverage` is 100% and deterministic;
      `deno task test:quality-audit` clean for new tests.
- [ ] `deno task precommit` (typecheck, `lint:ci`, tests, `cpd` at 0%) passes.
- [ ] PR notes the out-of-scope webhook auto-refund path (§9) and the deferred
      provider-amount enhancement (§10).
