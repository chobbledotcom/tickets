# Double-Entry Accounting — Design

## Status

**The `transfers` ledger is the single source of truth for money and balances.**
Every figure — income, outstanding balance, amount paid, refund totals, modifier
revenue — is a `SUM` projection over `transfers`. There is **no parallel money
state and no fallback path**: the denormalised money columns and their triggers
(`listing_attendees.price_paid`, `attendees.remaining_balance`, `listings.income`,
`modifiers.total_revenue`, the per-row `refunded` flag, and the money columns on
`modifier_usages`) are **deleted** as part of this work, not kept for backwards
compatibility (§8).

**Built so far:** the pure, context-free ledger library in
[`src/shared/ledger/`](src/shared/ledger/) (100% covered) and the `transfers`
table; the booking and refund money events post their legs to the ledger; the
one-shot backfill (§6) has reconstructed all history; a reusable batch-transfer
primitive (`postTransferGroups`, §4) posts many events atomically; and the first
two read concerns are fully swapped and their columns dropped — **refund status**
(no more `listing_attendees.refunded`) and **listing income** (no more
`listings.income`). **Remaining read concerns (§7):** amount paid
(`listing_attendees.price_paid`), outstanding balance
(`attendees.remaining_balance`), and modifier revenue (`modifiers.total_revenue`);
then the shared ledger renderer (§5.15) and the manual ledger-edit UI that
replaces the money-aggregate overrides (decision 14, currently just removed from
the form). **There is no dual-write phase** — see §7. **The code is the source of
truth for the model**; when code and prose disagree, the code wins and this doc is
updated to match.

### Production data invariants

The product owner has confirmed that, as of this migration, **no live site has
ever**:

- **written a `transfers` row** — the ledger is empty in production (Phase 0), so
  the backfill runs against an empty ledger and is the sole writer of history. The
  backfill's skip-already-ledgered and adopt-existing-currency guards (§6) are
  belt-and-suspenders against deploy re-ordering, not load-bearing.
- **used a modifier** — no historical surcharge/discount legs to reconstruct; the
  backfill posts `modifiers: []`.
- **done a partial refund** — every refund returned the whole payment, so a single
  flagged `listing_attendees.refunded` row means the whole order was refunded (the
  backfill reverses on *any* flagged line, not all).
- **taken a reservation** — no deposits or owed balances; every booking is paid in
  full (`remaining_balance` is uniformly zero), so a backfilled sale and its
  payment net the attendee to zero.

In short, **every historical booking is paid in full, refunded in full, or free**,
with no modifiers, deposits, or partial refunds. This bounds what the backfill (§6)
must reconstruct, and is why several reviewed edge cases — historical
modifier/reservation/partial-refund reconstruction, and double-posting onto an
attendee's existing booking legs — cannot arise on the real data, even where the
code still guards against them.

---

## 1. Goals & non-goals

**Goals**

- **One source of truth for money.** Every penny in or out is one immutable,
  timestamped row moving a positive `amount` from one account to another.
- **Balances are derived, never stored — and never duplicated.** Income,
  outstanding balance, refund totals, amount-paid, modifier revenue are all `SUM`
  over the ledger. The denormalised money columns and their triggers are
  **deleted** (§8); nothing reads them and there is no fallback path.
- **A pure, unit-testable library** with zero knowledge of tickets, attendees, or
  Stripe.
- **The financial record outlives the people in it.** Erasing an attendee must
  not delete the money that moved; transfers are PII- and provider-id-free.
- **One shared ledger renderer** for the historical list, the per-account
  statement, and the edit-attendee page.
- **Adjust history safely** — append corrections, never destructive edits.

**Non-goals (first version)**

- A user-editable chart of accounts (it's a small set of code constants).
- Tax computation (tax, if ever needed, is just another account).
- Multi-currency *operation* — single currency per site, **enforced** by the
  library refusing to sum across currencies.
- **Amount-aware provider refunds.** Partial refunds are **ledger-only** for now;
  an amount-aware provider API is planned and the model is shaped for it.
- Automated provider-fee/payout import (the model supports it; wiring is later).

---

## 2. Core model

One table. Every row moves a positive `amount` from a **source account** to a
**destination account** at a point in time, so each row is its own balanced
double entry — there is no way to write half a transaction.

- **Accounts are `(type, id)` — no accounts table.** Some are row-backed
  (id = attendee/listing/modifier row id); some are singletons with fixed ids
  (the outside world, each PSP, booking-fee income, write-off). An account
  "exists" when a transfer references it.
- **The attendee is a receivable/clearing account.** A sale *bills* the attendee
  (`attendee→revenue`); cash *funds* the attendee (`world→attendee`).
  **Outstanding(A) = −balanceOf(attendee:A)** — negative ⇒ owes, positive ⇒
  credit. This is what lets `price_paid`/`remaining_balance` be deleted.
- **Balances are derived:** `balance(A) = Σ(amount where dest=A) − Σ(amount where
  source=A)`.
- **Amounts are positive; direction encodes sign.** A refund moves the other way;
  a discount is the modifier account funding the attendee; a comp is the
  write-off account funding the attendee. `CHECK (amount > 0)`.
- **Recognition at sale, gross.** Modifiers/fees adjust via their own accounts, so
  the revenue account holds gross ticket sales and `balanceOf(modifier:M)` is that
  modifier's net effect. Deferred-to-event accrual is a later opt-in (`deposits`
  reserved).
- **Gross income vs net `balanceOf` (a nuance the swap surfaced).** A full refund
  reverses the sale leg (`revenue:L → attendee`), so `balanceOf(revenue:L)` =
  Σ(credits) − Σ(debits) is *net* recognised revenue (gross minus refunds). But the
  admin-facing **income** figure must match what admins see today — the legacy
  `SUM(listing_attendees.price_paid)`, which a refund did **not** reduce (the
  separate `refunded` flag tracked it). So the income projection is the **GROSS sum
  of revenue credits** — `SUM(amount) WHERE dest = revenue:L` — *not* `balanceOf`.
  Income deliberately does not subtract refunds, matching the column it replaced.
  (Per the owner: income/revenue figures only need to equal the current per-job
  admin display; historical precision — failed payments, pruned `processed_payments`
  — is explicitly not chased.)
- **Conservation is not reconciliation.** `Σ balance == 0` is structurally
  tautological — it can't see a duplicated row, a deleted row, or a row posted to
  the wrong account. Real integrity comes from reconciling against source records
  and provider balances (see `reconcile.ts` and §6).

---

## 3. Chart of accounts

```ts
ATTENDEE   "attendee"     // row-backed: attendees.id — the receivable
REVENUE    "revenue"      // row-backed: listings.id — gross ticket sales
MODIFIER   "modifier"     // row-backed: modifiers.id — discount/surcharge
FEE_INCOME "fee_income"   // singleton income: the operator's booking fee
WRITEOFF   "writeoff"     // singleton contra-revenue: comps / write-offs
EXTERNAL   "external"     // singleton: outside world (cards, bank)  → id "world"
PSP        "psp"          // id = "stripe" | "square" | "sumup"      (later)
FEES_PAID  "fees"         // singleton expense: provider fees we pay  (later)
DEPOSITS   "deposits"     // singleton liability: deposits held       (later)
```

Singletons get display names from a small map; row-backed accounts use the
stringified row id.

---

## 4. The library — `src/shared/ledger/` (built)

Context-free, no I/O, no clock, no crypto. Time, ids, and references are inputs.
100% covered. It may lean on trusted, side-effect-free libraries for primitives
that are a poor fit for hand-rolling — instant validation is delegated to
`Temporal` (`shared/validation/timestamp.ts`), which rejects impossible dates
(Feb 30) that a regex or `Date.parse` would accept.

| Module | Responsibility |
| --- | --- |
| `types.ts` | `AccountRef`, `TransferInput`, `Transfer`, `Result`, `LedgerError`. `occurredAt`/`recordedAt` are ISO strings in memory; the store persists them as INTEGER epoch-millis (§6). |
| `account.ts` | Identity + a NUL-separated, collision-free `accountKey`. |
| `validate.ts` | Positive safe-integer amount, a real ISO-8601 `occurredAt` instant (any offset/precision, but not an impossible date — `Temporal`-backed), distinct non-empty accounts, non-empty currency/reference/eventGroup. Reports every problem at once. |
| `project.ts` | `balanceOf`, `allBalances`, `sumOfKind`, `inPeriod`, `statementFor` (time-then-id ordered, opening-balance aware) — all **currency-guarded** (mixed-currency slices throw). |
| `reverse.ts` | `reverseOf` — the exact inverse for admin void/correction (not refunds). |
| `reconcile.ts` | Non-tautological checks: `reconcileExternal` (vs a provider-reported balance) and `reconcileLegs` (observed leg *fingerprints* — kind, accounts, amount, currency — per event vs source-record expectations). |

**Built — the host glue in `src/shared/accounting/` (persistence + mapping,
integration-tested):** the chart of accounts (`accounts.ts`), opaque HMAC
references (`refs.ts`), event mappers (`mappers.ts`: `mapBooking`, `mapRefund`),
the SQL row plumbing and guarded compare-and-post inserts (`rows.ts`), the
idempotent write path with replay/reversal conflict checks (`store.ts`,
`conflicts.ts`), and the balance read queries (`queries.ts`).

**Batch-transfer primitive (`postTransferGroups`, in `store.ts`).** The reusable
way to post **many independent events at once** — a bulk refund, an import, a
multi-order adjustment. It is split so it scales: a read-only **prepare** loads one
`BatchSnapshot` in a fixed handful of bulk queries (never one-per-group) and
validates every group against it (idempotent replay, changed-leg conflict, cross-
event *and* cross-batch reference collisions, single-currency, reversal links),
then a write-only **apply** runs one atomic `batch` of just the resulting
`INSERT OR IGNORE`s. This is the deliberate alternative to a long *interactive*
transaction: reads interleaved with writes inside one interactive write tx leave
result sets open that libsql refuses to commit at scale (`SQL statements in
progress`). Doing all reads first means the write is a pure insert list, so a plain
atomic batch commits cleanly however many events it carries; deterministic
references make `INSERT OR IGNORE` absorb a concurrent race (the backfill's
approach). The single-event path (`postTransfersTx`) stays interactive so it can
ride a booking's own transaction.

---

## 5. Resolved decisions

1. **All-in, no parallel money state**; any future cache is ledger-rebuilt.
2. **Recognition at sale, gross**; modifiers/fee via own accounts; deferred
   accrual later (`deposits` reserved).
3. **Booking fee is income** (`fee_income:booking`); the cash leg equals the
   amount actually charged.
4. **Single currency, enforced in code** (`assertSingleCurrency`).
5. **Balance settlement keeps a live atomic guard** and **refunds on
   guard-reject** — never a silent no-op.
6. **References are opaque HMACs**, never provider ids; each event's legs share an
   `event_group`.
7. **Paid-path finalize must be batched** with creation + token-resolved ledger
   inserts — a Phase-1 prerequisite (the paid path finalizes separately today).
8. **Refunds reverse the original legs** + one guarded `refund_cash`; they do not
   use `reverses_id`; reports sum `refund_cash` only.
9. **Partial refunds are ledger-only for now**; full refunds call the provider. An
   amount-aware `refundPayment(ref, amount?)` is the planned path to provider-side
   partials.
10. **At most one *void* per original** (unique `reverses_id`); refunds tracked
    via `event_group` + over-refund guard.
11. **Comps/write-offs come from a `writeoff` contra-revenue account**, not
    external cash, so cash reports stay honest.
12. **`modifier_usages` stays as a stock ledger** (money stripped).
13. **`Σ balance == 0` is a sanity check only**; reconcile against provider
    balances and per-event leg kinds.
14. **Manual money-aggregate overrides become ledger edits, with a warning.** The
    admin "override aggregate values" action survives, but splits by kind. The
    *non-money counts* (`booked_quantity`, `tickets_count`) stay plain column
    overrides. Every *money* figure it used to set — a listing's income, an
    attendee's outstanding balance, a modifier's revenue — instead posts a manual
    `adjustment` leg against the `writeoff` contra account: lowering a listing's
    income is `revenue:L → writeoff` and raising it the reverse; changing what an
    attendee owes is `attendee ↔ writeoff`. The form computes the delta from the
    current `SUM` projection and posts only the difference, and the UI **warns**
    that this edits the source-of-truth ledger. Corrections are appended, never
    destructive; sensitive-content edits **log redacted**, never the raw value.
    **Status:** not yet built. As each money concern is swapped, its field is for
    now **removed** from the override form (income went with concern 3;
    `LISTING_AGGREGATE_FIELDS` is down to the two counts), leaving the form a
    counts-only override. The ledger-edit UI that restores money correction as a
    warned `writeoff` adjustment is tracked as remaining work (§7), to land once the
    per-account reads exist for every money figure it touches.
15. **One shared ledger renderer** for the historical list, the account
    statement, and the edit-attendee page.
16. **Carts are all-or-nothing** (via `ensureAllBookings`); order legs ride the
    create batch under one `eventGroup`, deleted as a group on rollback.
17. **Attendee merge rewrites the source's ledger rows to the target attendee
    id** — the only sanctioned mutation of account ids, done inside the merge
    batch and logged. Every source leg moves wholesale onto the target (both
    records' real payments legitimately follow the person), so no money is
    stranded on the deleted source.
18. **A memo that could carry PII is owner-key encrypted by the host** before
    persisting; the ledger treats it as an opaque string and never logs it.

---

## 6. Constraints checklist

Every accepted review finding, distilled. Each must be satisfied (in code, with
tests) before the corresponding path goes live.

### Persistence & idempotency

- [x] `transfers` table: `NOT NULL` columns, `CHECK (amount > 0)`, **unique
  `reference`**, indexes on `(source_type, source_id)`, `(dest_type, dest_id)`,
  `(occurred_at)`, and a **unique partial index on `reverses_id`**. `occurred_at`
  and `recorded_at` are **INTEGER epoch-millis** so the time index sorts and
  ranges chronologically with integer comparisons at high row counts; the host
  normalises any ISO instant to epoch-millis on write and reads it back canonical.
- [x] Idempotent insert **verifies the existing event's immutable columns match the
  retry** (amount, accounts, kind, currency) and **fails loudly** on mismatch
  (`assertEventMatches`); the single path reads through its own write tx, the batch
  path validates against the pre-loaded snapshot then writes `INSERT OR IGNORE`.
- [x] HMAC `event_group`/`reference` inputs are **JSON-encoded** before hashing —
  never `|`-joined — so different part arrays can't collide onto one key (`refs.ts`).

### Paid-checkout atomicity (P1)

- [ ] Posting transfers **and** finalizing `processed_payments` happen in one
  batch that sits **behind all rollback gates** (capacity **and** modifier-stock),
  or rollback **atomically marks the payment terminally failed**. Today the paid
  path finalizes separately and `createAttendeeAtomic` is greedy (a zero-row
  capacity/stock insert doesn't abort the batch; `ensureAllBookings` /
  `consumeModifierStock` delete-and-refund *after*). A real folded-in finalize
  statement + transfer-group cleanup on rollback is required.
- [ ] The attendee row id isn't known until insert — bind ledger
  `source_id`/`dest_id` via the same token-resolved subquery the create batch
  uses (or preallocate the id), so the legs ride the create batch.

### Settlement guards (balance payments)

- [ ] Keep an **atomic ledger-side compare-and-post** guard (don't replace the
  existing `remaining_balance = expected` guard with a plain append).
- [ ] The guard subquery is **account-scoped** (uses the source/dest indexes, not
  an O(ledger) currency scan) **and currency-scoped** (`currency = ?`).
- [ ] Compare against the **signed** expected balance: outstanding =
  −balanceOf(attendee), so the guard compares to `−expectedAmount`, not the
  positive checkout amount.
- [ ] If the guard affects 0 rows the provider charge already succeeded → take the
  existing **refund / recorded-failure** path; never a silent no-op.

### Refunds

- [x] A refund **reverses the original sale/fee/modifier legs** (not always
  `revenue`) plus one guarded `refund_cash` (`mapRefund`).
- [x] Refund **status is the `refund_cash` leg** — `refunded` iff a `refund_cash`
  leg sourced from the attendee exists. The per-row column is gone (concern 2).
- [x] **A missed ledger post must fail loudly.** With the `refunded` column gone the
  `refund_cash` leg is the *only* refund record, so a post that doesn't land can't
  be swallowed or the payment reads as un-refunded and stays re-refundable.
  `recordAttendeeRefund` returns `{ posted }` and never throws (the provider refund
  already committed); the single, bulk, and refresh-payment routes surface
  `posted:false` as a manual-adjustment error / errored tally. A guard-skip (not a
  single fully-paid ledgered order) is also `posted:false`.
- [ ] Remaining-refundable is scoped to the **order (`event_group`)**, not the
  attendee — merge can put several orders on one attendee. (Today's full refund
  auto-reverses only a *single* fully-paid order; multi-order/partial cases go to a
  manual adjustment rather than being mis-reversed.)
- [x] Refund totals sum **`refund_cash` only** (a refund posts ≥2 legs).
- [ ] Repeat partial refunds are tracked via `event_group` + over-refund guard,
  **not** `reverses_id` (one slot). (Partial refunds remain a later, amount-aware
  piece — decision 9.)

### Merge

- [ ] Re-point only the legs of orders **actually merged**; skipped/duplicate
  source bookings keep their legs on a tombstone — don't move discarded orders'
  money onto the target.

### PSP modelling (later)

- [ ] Until card payments actually route through `psp:<provider>`, **defer**
  `reconcileExternal(psp, …)` — it has nothing to compare against.
- [ ] When fees/payouts land, use a **separate clearing account** so
  `balanceOf(psp)` reconciles to the provider-reported balance after payout —
  the PSP account must not both hold cash and clear the receivable.

### Admin / void / privacy

- [ ] At most **one void per original** (unique partial index on `reverses_id`); a
  double-submit must not over-reverse.
- [ ] Sensitive-content edits log **redacted field names/hashes + actor +
  transfer id**, never the raw memo (which would re-copy PII into `activity_log`).
- [ ] PII-bearing memos are **owner-key encrypted** before persisting.

### Reports (correctness)

- [ ] Net revenue = `SUM` of the balances of the **selected** income/contra-income
  account keys (`revenue:*`, `modifier:*`, `fee_income:*`, **and `writeoff:*`**) —
  **not** the sum of every value in `allBalances` (that's 0 by conservation).
  Include `writeoff:*` or label the metric "gross recognised".
- [ ] Cash-vs-recognised compares cash (`world→*`) against **all** recognised
  income (revenue + fee_income + modifiers), not just `revenue` — else a
  fee/modifier order shows a phantom receivables gap.
- [ ] Reconciliation stays non-tautological (external balance + source-driven leg
  **kinds**).

### Backfill (mandatory — no column survives to fall back to)

The columns are deleted, so the backfill's output *becomes* the historical record.
**No modifier or reservation has ever existed in production**, so every historical
booking is paid in full with no discount/surcharge and the reconstruction is exact:

- [ ] Per **attendee** with paid rows, post one event group (`backfill:att:<id>`):
  a **sale** (`attendee → revenue`) for each listing line's `price_paid` and one
  **payment** (`world → attendee`) for the total; the attendee nets to zero (paid
  in full). One group per attendee mirrors the live flow — a multi-listing booking
  is one order — so a later admin refund still finds a single booking order. Same
  reference keys as the live mappers; written as a batch with `INSERT OR IGNORE`
  on the unique reference (idempotent re-run), **not** an interactive transaction,
  so it never contends the single SQLite writer mid-migration.
- [ ] **Fully-refunded attendees** also post the reversal of that booking group
  plus a `refund_cash`, matching the live refund mapping. Production refunds are
  all-or-nothing, so a partially-refunded order is left booked for a manual check
  rather than mis-reversed.
- [ ] No historical `fee`/`modifier`/reservation legs exist to reconstruct;
  `remaining_balance` is uniformly zero. Going forward, the ledger records fees,
  modifiers, and deposits as their own legs.
- [ ] Ships as a **data-only migration** (`2026-06-22_backfill_transfers`, empty
  `requires`) that bumps `LATEST_UPDATE` so already-up-to-date sites run it; a
  fresh database baselines it without running `up()` (no history to backfill).
- [ ] **Reconcile before dropping columns:** the backfilled ledger's `SUM`
  projections must equal the pre-migration `SUM(price_paid)` (amount paid and
  income) and refunded totals; a mismatch blocks the drop.

---

## 7. Delivery

The end state is ledger-only, and there is **no dual-write stage** — keeping the
legacy money columns and the ledger in step in parallel is exactly the complexity
this avoids. The ledger is already populated (bookings and refunds post their legs;
the backfill (§6) reconstructed all history), so each legacy money column is
swapped **straight** to its `SUM` projection and deleted in one change, covered by
the existing exhaustive tests. No intermediate dual-source window, and no read is
ever served from two places at once.

Swap one concern at a time — each is a self-contained commit that points any
remaining writes at the ledger (the sole write, not alongside the column), points
every read at the projection, drops the column and its triggers, and updates the
tests:

1. **Backfill** history into the ledger (§6) — **done**.
2. **Refund status** — `listing_attendees.refunded` → EXISTS a `refund_cash` leg
   sourced from the attendee. **Done.** A missed post surfaces (`posted:false`), so
   the refund record is never silently lost now that the column is gone (§6).
3. **Listing income** — `listings.income` (+ its trigger) → the **GROSS sum of
   `revenue:L` credits** (`SUM(amount) WHERE dest = revenue:L`), *not* `balanceOf`
   (which would net out refunds — see §2). This matches the legacy
   `SUM(price_paid)` admins see today. **Done.** The income field is **removed** from
   the "override aggregate values" form for now (the counts —
   `booked_quantity`, `tickets_count` — stay column overrides); restoring it as a
   warned `writeoff` ledger edit is decision 14's deferred work.
4. **Amount paid** — `listing_attendees.price_paid` → the attendee's payment legs
   (the largest read surface: templates, tickets/wallets, webhooks, CSV, email).
5. **Outstanding balance** — `attendees.remaining_balance` → `−balanceOf(attendee)`
   (uniformly zero in production — no reservations).
6. **Modifier revenue** — `modifiers.total_revenue` (+ trigger) →
   `balanceOf(modifier:M)` (no modifier has ever been used in production).

**Swap lesson (learned on concerns 2–3, applies to the rest).** Dropping a money
column breaks **every** read of it, not just the headline query — a `SELECT *`
batch loader silently yields `undefined` → `NaN` once the column is gone (this bit
the two listing+attendees batch loaders, caught by Codex and now regression-tested).
So each swap must route **every** read site through the projection, ideally via one
shared SQL fragment (e.g. `listingIncomeSubquery`) so the source lives in one place.
Concern 4 (`price_paid`) has by far the most read sites, so inventory them first.

A single shared ledger renderer (§5.15) follows once the per-account reads are in
place. `booked_quantity` / `tickets_count` are counts, not money, so they stay.

---

## 8. What this deletes

Removed outright — no compatibility shim — once every read is on the ledger
(`[x]` = already dropped):

- [ ] `listing_attendees.price_paid`
- [ ] `attendees.remaining_balance`
- [x] `listings.income` and its maintaining trigger (the three aggregate triggers
  were rebuilt to keep `booked_quantity`/`tickets_count` only)
- [ ] `modifiers.total_revenue` and its maintaining trigger
- [x] the per-row `refunded` money flag on `listing_attendees`
- [ ] the money columns on `modifier_usages` (the table survives as a non-money
  stock ledger)

Each becomes a `SUM` projection over `transfers`.
