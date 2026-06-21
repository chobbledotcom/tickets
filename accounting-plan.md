# Double-Entry Accounting — Design

## Status

**Phase 0 is built and shipped:** the pure, context-free ledger library lives in
[`src/shared/ledger/`](src/shared/ledger/) with 100% branch+line coverage. **That
code is the source of truth for the model.** This document deliberately carries no
pseudocode — only the decisions, the account chart, and the Phase-1 constraints
checklist (every accepted review finding distilled into something implementable).
When code and prose disagree, the code wins; update this doc to match.

---

## 1. Goals & non-goals

**Goals**

- **One source of truth for money.** Every penny in or out is one immutable,
  timestamped row moving a positive `amount` from one account to another.
- **Balances are derived, never stored.** Income, outstanding balance, refund
  totals, amount-paid, modifier revenue — all become `SUM` over the ledger; the
  denormalised money columns and their triggers are retired (§8).
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
  `balanceOf(revenue:L)` is gross sales and `balanceOf(modifier:M)` is that
  modifier's net effect. Deferred-to-event accrual is a later opt-in (`deposits`
  reserved).
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

Pure, context-free, no I/O, no clock, no crypto. Time, ids, and references are
inputs. 100% covered.

| Module | Responsibility |
| --- | --- |
| `types.ts` | `AccountRef`, `TransferInput`, `Transfer`, `Result`, `LedgerError`. |
| `account.ts` | Identity + a NUL-separated, collision-free `accountKey`. |
| `validate.ts` | Positive safe-integer amount, canonical ISO-UTC `occurredAt`, distinct non-empty accounts, non-empty currency/reference/eventGroup. Reports every problem at once. |
| `project.ts` | `balanceOf`, `allBalances`, `sumOfKind`, `inPeriod`, `statementFor` (time-then-id ordered, opening-balance aware) — all **currency-guarded** (mixed-currency slices throw). |
| `reverse.ts` | `reverseOf` — the exact inverse for admin void/correction (not refunds). |
| `reconcile.ts` | Non-tautological checks: `reconcileExternal` (vs a provider-reported balance) and `reconcileLegs` (observed leg *fingerprints* — kind, accounts, amount, currency — per event vs source-record expectations). |

**Not yet built — lands in Phase 1 (persistence boundary, integration-tested):**
the SQL statement descriptors (`statements.ts`: idempotent insert + the
guarded compare-and-post inserts) and the `LedgerStore` port + adapter
(`ports.ts`/`store.ts`). They were intentionally deferred from Phase 0 because
their correctness is only meaningful against a real database.

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
14. **Corrections are the default**; a destructive edit exists on
    `/admin/accounting` but warns and steers to an attendee-ledger adjustment;
    sensitive-content edits **log redacted**, never the raw value.
15. **One shared ledger renderer** for the historical list, the account
    statement, and the edit-attendee page.
16. **Carts are all-or-nothing** (via `ensureAllBookings`); order legs ride the
    create batch under one `eventGroup`, deleted as a group on rollback.
17. **Attendee merge re-points the receivable account** — the only sanctioned
    mutation of account ids, confined to the merge batch and logged.
18. **A memo that could carry PII is owner-key encrypted by the host** before
    persisting; the ledger treats it as an opaque string and never logs it.

---

## 6. Phase-1 constraints checklist

Every accepted review finding, distilled. Each must be satisfied (in code, with
tests) before the corresponding path goes live.

### Persistence & idempotency

- [ ] `transfers` table: `NOT NULL` columns, `CHECK (amount > 0)`, **unique
  `reference`**, indexes on `(source_type, source_id)`, `(dest_type, dest_id)`,
  `(occurred_at)`, and a **unique partial index on `reverses_id`**.
- [ ] Idempotent insert (`ON CONFLICT(reference) DO NOTHING`) **must verify the
  existing row's immutable columns match the retry** (amount, accounts, kind,
  currency); on mismatch **fail loudly** — never silently keep a different row.
- [ ] HMAC `event_group`/`reference` inputs are **length-prefixed or
  JSON-encoded** before hashing — never `|`-joined — so different part arrays
  can't collide onto one key.

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

- [ ] A refund **reverses the original sale/fee/modifier legs** (not always
  `revenue`) plus one guarded `refund_cash`.
- [ ] Remaining-refundable is scoped to the **order (`event_group`)**, not the
  attendee — merge can put several orders on one attendee.
- [ ] The remaining-refundable guard covers the **whole refund batch** (reversals
  + cash), or the reversal legs are rolled back when the cash guard affects 0 rows
  (a 0-row guarded insert does not abort the batch).
- [ ] Refund totals sum **`refund_cash` only** (a refund posts ≥2 legs).
- [ ] Repeat partial refunds are tracked via `event_group` + over-refund guard,
  **not** `reverses_id` (one slot).

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

### Backfill (each needs an explicit unrecoverable / manual-review path)

- [ ] Historical **booking-fee** income is not reconstructable from `price_paid`
  (the fee was a provider extras line) → mark unrecoverable or derive from a real
  stored amount.
- [ ] **Open-reservation gross** is not reconstructable (`price_paid` = deposit;
  `remaining_balance` is order-level) → best-effort / manual review.
- [ ] **Multi-listing shared-payment refunds** aren't reconstructable from
  per-listing `refunded` flags → order-level recovery or manual review.
- [ ] **Modifier direction** (discount vs surcharge) isn't reliable from
  `amount_applied` alone → needs an immutable signed delta going forward.
- [ ] Backfill **parity oracles** must compare against the right historical
  aggregate (gross `SUM(price_paid)` before refund legs; account for refunded
  rows; exclude open reservations whose `price_paid` is only a deposit).

---

## 7. Phasing

- **Phase 0 — ✅ library + table, zero behaviour change.** Pure library shipped;
  the `transfers` table is the remaining Phase-0 schema step.
- **Phase 1 — persistence + dual-write.** Statement descriptors + `LedgerStore`
  adapter + chart/refs + event mappers; the prerequisite paid-finalize refactor;
  dual-write new money events to the ledger; backfill history (with the caveats
  above). Satisfy the §6 checklist with integration tests.
- **Phase 2 — migrate reads to the ledger;** add the reports and the one shared
  admin renderer.
- **Phase 3 — retire** every redundant money column and trigger (§8); reads come
  only from the ledger.

---

## 8. What this retires (eventually)

The denormalised money state the ledger replaces: stored `price_paid`,
`remaining_balance`, `modifiers.total_revenue`, the `listings.income` trigger, and
the per-row `refunded` money semantics — all become `SUM` projections over
`transfers`. (`modifier_usages` survives as a non-money stock ledger.)
