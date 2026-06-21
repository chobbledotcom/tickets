# Double-Entry Accounting — Design Doc

A plan to replace the platform's scattered, mutable money state with a single
append-only **transfer ledger**, fronted by a small, pure, context-free
accounting library that the rest of the system hooks into.

We go **all-in**: the ledger becomes the single source of truth for 100% of
accounting. Every column that records money is removed once its reads are
migrated — no parallel money state, no "cache that's also a source of truth".

Status: **proposal**. Nothing here is built yet. This doc is the thing to argue
with before any code is written. It has had **two rounds of adversarial review**
folded in — see §17 for the resolved findings.

---

## Table of contents

1. [Goals & non-goals](#1-goals--non-goals)
2. [Why — what we have today and why it hurts](#2-why--what-we-have-today-and-why-it-hurts)
3. [The core model: transfers between typed accounts](#3-the-core-model-transfers-between-typed-accounts)
4. [The library (`src/shared/ledger/`) — pure & context-free](#4-the-library-srcsharedledger--pure--context-free)
5. [Persistence: the `transfers` table](#5-persistence-the-transfers-table)
6. [The host glue (`src/shared/accounting/`) — chart of accounts & event mappers](#6-the-host-glue-srcsharedaccounting--chart-of-accounts--event-mappers)
7. [Mapping every money event to transfers](#7-mapping-every-money-event-to-transfers)
8. [Attendee deletion & data retention](#8-attendee-deletion--data-retention)
9. [Idempotency & concurrency](#9-idempotency--concurrency)
10. [Admin view & adjusting the historical record](#10-admin-view--adjusting-the-historical-record)
11. [Reporting unlocked](#11-reporting-unlocked)
12. [Migration plan](#12-migration-plan)
13. [Testing strategy](#13-testing-strategy)
14. [What this retires — the definitive removal list](#14-what-this-retires--the-definitive-removal-list)
15. [Decisions (resolved)](#15-decisions-resolved)
16. [Risks & mitigations](#16-risks--mitigations)
17. [Review findings folded in](#17-review-findings-folded-in)

---

## 1. Goals & non-goals

### Goals

- **One source of truth for money.** Every penny in or out is one immutable,
  timestamped row describing a transfer from one account to another.
- **Balances become derived, never stored.** Income, outstanding balances,
  refund totals, amount-paid, modifier revenue — all become `SUM` over the
  ledger. The denormalised money columns and their triggers are deleted (§14).
- **A pure, unit-testable accounting library** with zero knowledge of tickets,
  attendees, or Stripe.
- **The financial record outlives the people in it.** Erasing an attendee must
  not delete the money that moved. Transfers are PII- and provider-id-free.
- **The same ledger view everywhere.** The full historical ledger list and the
  per-attendee ledger on the **edit-attendee page** render through *one* shared
  component — same format, no duplication (§10).
- **Adjust history safely** — append corrections, never destructive edits.

### Non-goals (for the first version)

- A user-editable chart of accounts (it's a small set of code constants).
- Tax computation (tax, if ever needed, is just another account).
- Multi-currency *operation* — single-currency per site, **enforced** by the
  library refusing to sum across currencies (§4.5).
- **Amount-aware provider refunds.** Partial refunds are **ledger-only** for now
  (recorded in the ledger; the provider isn't asked to refund a partial amount).
  An amount-aware provider API is planned (§15.9) and the model is already shaped
  for it.
- Automated provider-fee/payout import (the model supports it, §7.8; wiring is
  later).

---

## 2. Why — what we have today and why it hurts

Money today is **mutable state spread across four independent mechanisms**, each
maintained by its own bespoke trigger/code:

| Where | What it stores | The pain |
| --- | --- | --- |
| `listing_attendees.price_paid` → `listings.income` (3 triggers, `schema.ts:111-113`, `823-871`) | per-line amount, summed to a lifetime `income` column | all-time only — **no date dimension**; refunded rows still counted |
| `attendees.remaining_balance` (`schema.ts:277`) + `settleAttendeeBalance` (`balance.ts:152-212`) | outstanding deposit balance | a balance payment is **folded into the earliest line's `price_paid`** (`balance.ts:180-183`) — the deposit/balance split and its timestamps are destroyed |
| `listing_attendees.refunded` 0/1 flag (`schema.ts:313`) | "was this refunded" | **no amount, no date**; partial/repeat refunds impossible |
| `modifier_usages.amount_applied` + 3 triggers + `modifiers.total_revenue`/`total_uses`/`usage_count` | discount/surcharge money + counts | already an append-only ledger — just a *separate* one |

The decisive consequence: **an operator cannot answer "what did I take in,
refund, and net over date range X?"** Refund amounts are never recorded; income
has no time axis; the deposit/balance history is overwritten on settlement; and
the **booking fee charged at checkout is never recorded per booking** (it's added
to the provider charge via `feeExtras` in `checkout-pricing.ts` but not stored).

Two things make this *low-novelty*:

1. **The pattern exists in-house, twice.** `modifier_usages` is an append-only
   ledger with guarded atomic inserts (`modifier-usage.ts:38-85`), trigger-
   maintained aggregates, and a recalculation/audit endpoint
   (`features/admin/aggregate-recalculation.ts`). The transfer ledger generalises
   it.
2. **Amounts are already plaintext integer minor units** (`currency.ts`); ids are
   plaintext FKs. No new encryption design — provided rows carry no provider ids
   (§8).

Aligns with `AGENTS.md`: *make invalid arrangements unrepresentable* (a one-row
transfer can't be unbalanced), *trust application invariants* (reconcile against
source records, §4.9), *malleable software* (operator views/repairs records, §10).

---

## 3. The core model: transfers between typed accounts

One table. Every row moves a positive `amount` from a **source account** to a
**destination account** at a point in time:

```
transfer:  (source_type, source_id)  ──amount──▶  (dest_type, dest_id)
```

Each row carries both ends, so it is its own balanced double entry. **There is no
way to write half a transaction.**

### Accounts are `(type, id)` — no accounts table

Some are **row-backed** (id = a row id: attendee, listing, modifier); some are
**singletons** with hardcoded ids (the outside world, each PSP, the booking-fee
income bucket, the write-off bucket). An account "exists" when a transfer
references it; a tiny map gives singletons display names (§6).

### The attendee is an account (this is what lets us delete `price_paid`/`remaining_balance`)

Each attendee is a **receivable / clearing account.** A sale *bills* the attendee;
cash *funds* the attendee; its balance is exactly what they still owe.

- Bill the sale: `attendee:A → revenue:L` (gross list price)
- Bill the booking fee: `attendee:A → fee_income:booking`
- Fund with cash (the *full* amount charged): `world → attendee:A`
- **Outstanding(A) = −balanceOf(attendee:A)** — negative ⇒ owes, positive ⇒ credit.

### Balances are derived

`balance(A) = SUM(amount where dest = A) − SUM(amount where source = A)`

### Amounts are positive; direction encodes sign

A refund is a transfer the other way; a discount is the modifier funding the
attendee; a comp is the write-off account funding the attendee. `CHECK (amount > 0)`.

### Recognition basis (decided)

Revenue is recognised **at sale** (gross), matching today. Modifiers/fees adjust
via their own accounts, so `balanceOf(revenue:L)` is gross sales and
`balanceOf(modifier:M)` is that modifier's net effect (today's `total_revenue`).
"Income" headline = recognised net revenue. (Deferred-to-event accrual is a later
opt-in, §15.)

> **Conservation note (don't over-trust it).** `Σ balance(A) == 0` is
> **structurally tautological** for a one-row-balanced ledger — it can't detect a
> duplicated row, a deleted row, or a row posted to the *wrong* account. It is a
> cheap sanity check, not reconciliation. Real integrity comes from reconciling
> against source records and provider balances (§4.9, §10.2).

---

## 4. The library (`src/shared/ledger/`) — pure & context-free

> Knows accounts, transfers, balances, invariants. Knows nothing of attendees,
> listings, or Stripe. Imports only `#fp`. Time and id generation are **inputs**.

### 4.1 Module layout

```
src/shared/ledger/
  types.ts        # AccountRef, TransferInput, Transfer, errors
  account.ts      # canonical key, equality, helpers (pure)
  validate.ts     # TransferInput -> Result (pure)
  project.ts      # balances, statements, period buckets, kind sums (pure)
  reconcile.ts    # non-tautological reconciliation checks (pure)
  reverse.ts      # reversing/adjusting transfer construction (pure)
  statements.ts   # TransferInput -> { sql, args } descriptors (pure)
  ports.ts        # the LedgerStore interface (types only)
  mod.ts          # barrel
```

Everything except `ports.ts` is pure and runs without a DB. The host wires a
libsql adapter to `ports.ts` in `src/shared/accounting/` (§6).

### 4.2 Value types (`types.ts`)

```ts
export type AccountRef = { readonly type: string; readonly id: string };
export type MinorUnits = number; // positive integer, minor units

export type TransferInput = {
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: MinorUnits;
  readonly currency: string;       // ISO-4217, opaque
  readonly occurredAt: string;     // ISO business time
  readonly reference: string;      // opaque idempotency key (HMAC/UUID), §8
  readonly eventGroup: string;     // shared id for all legs of one event, §4.9/§6.2
  readonly kind?: string;          // host category (e.g. "refund_cash")
  readonly memo?: string;          // PII-free reason (host responsibility, §8)
  readonly reversesId?: number;    // void/correction link ONLY — not refunds (§7.3)
  readonly postedBy?: string;      // "system" or admin user id
};

export type Transfer = TransferInput & { readonly id: number; readonly recordedAt: string };

export type LedgerError =
  | { code: "non_positive_amount" } | { code: "non_integer_amount" }
  | { code: "self_transfer" } | { code: "empty_account" }
  | { code: "empty_currency" } | { code: "empty_reference" } | { code: "empty_event_group" };

export type Result<T> = { ok: true; value: T } | { ok: false; errors: LedgerError[] };
```

### 4.3 Account helpers (`account.ts`) — pure

```ts
const SEP = " "; // NUL
export const accountKey = (a: AccountRef): string => `${a.type}${SEP}${a.id}`;
export const sameAccount = (a: AccountRef, b: AccountRef): boolean =>
  a.type === b.type && a.id === b.id;
export const account = (type: string, id: string | number): AccountRef => ({ type, id: String(id) });
```

### 4.4 Validation (`validate.ts`) — pure

Validates: amount positive integer; source ≠ destination; non-empty account
parts, currency, reference, and `eventGroup`. Returns `Result`.

### 4.5 Projections (`project.ts`) — pure, currency-guarded

They **refuse to sum across currencies** — the single-currency decision (§15) is
enforced here, not just in prose. `statementFor` **sorts by `(occurredAt, id)`**
so running balances are correct regardless of the order rows arrive in.

```ts
import { filter, sumOf, unique } from "#fp";
import { accountKey, sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

export const assertSingleCurrency = (transfers: Transfer[]): void => {
  const cs = unique(transfers.map((t) => t.currency));
  if (cs.length > 1) throw new Error(`mixed-currency ledger slice: ${cs.join(", ")}`);
};

export const balanceOf = (acct: AccountRef) => (transfers: Transfer[]): number => {
  assertSingleCurrency(transfers);
  const into = sumOf((t: Transfer) => (sameAccount(t.destination, acct) ? t.amount : 0))(transfers);
  const out = sumOf((t: Transfer) => (sameAccount(t.source, acct) ? t.amount : 0))(transfers);
  return into - out;
};

export const allBalances = (transfers: Transfer[]): Map<string, number> => {
  assertSingleCurrency(transfers);
  const acc = new Map<string, number>();
  for (const t of transfers) {
    acc.set(accountKey(t.destination), (acc.get(accountKey(t.destination)) ?? 0) + t.amount);
    acc.set(accountKey(t.source), (acc.get(accountKey(t.source)) ?? 0) - t.amount);
  }
  return acc;
};

export const sumOfKind = (kind: string) => (transfers: Transfer[]): number => {
  assertSingleCurrency(transfers);
  return sumOf((t: Transfer) => (t.kind === kind ? t.amount : 0))(transfers);
};

export const inPeriod = (from: string, to: string) => (transfers: Transfer[]): Transfer[] =>
  filter((t: Transfer) => t.occurredAt >= from && t.occurredAt < to)(transfers);

export type StatementLine = { transfer: Transfer; signed: number; running: number };
export const statementFor = (acct: AccountRef) => (transfers: Transfer[]): StatementLine[] => {
  const lines = filter(
    (t: Transfer) => sameAccount(t.source, acct) || sameAccount(t.destination, acct),
  )(transfers)
    .slice()
    .sort((a, b) => (a.occurredAt === b.occurredAt ? a.id - b.id : a.occurredAt < b.occurredAt ? -1 : 1));
  let running = 0;
  return lines.map((transfer) => {
    const signed = sameAccount(transfer.destination, acct) ? transfer.amount : -transfer.amount;
    running += signed;
    return { running, signed, transfer };
  });
};
```

### 4.6 Reversals & adjustments (`reverse.ts`) — pure

`reverseOf(t, meta)` builds the inverse (swapped ends, same amount, `reversesId =
t.id`). Used **only for admin void/correction** (§10) — *not* for refunds (§7.3).
At most one void per transfer is enforced by the schema (unique `reverses_id`, §5).

### 4.7 Statement descriptors (`statements.ts`) — pure, the batching linchpin

The library emits `{ sql, args }` descriptors the host folds into its own atomic
batch (alongside `processed_payments` finalize, §9). Three shapes:

1. **`insertTransferStatement`** — plain idempotent insert (`ON CONFLICT(reference)
   DO NOTHING`). For callers where both account ids are already known (balance
   settle, refund, admin, backfill).
2. **`guardedInsertOnBalance`** — posts only while a named account's balance still
   equals `expected`, for the balance-settlement compare-and-post (§7.2). The
   subquery is **account-scoped** (filters to rows touching that account so it
   uses the source/dest indexes — not an O(ledger) currency-wide scan):

   ```sql
   INSERT INTO transfers (...) SELECT ?, ?, ...
   WHERE (
     SELECT COALESCE(SUM(CASE WHEN dest_type=? AND dest_id=? THEN amount
                              WHEN source_type=? AND source_id=? THEN -amount ELSE 0 END), 0)
     FROM transfers
     WHERE (dest_type=? AND dest_id=?) OR (source_type=? AND source_id=?)
   ) = ?
   ON CONFLICT(reference) DO NOTHING
   ```

3. **`guardedRefundCash`** — posts a `refund_cash` leg only while the order's
   *remaining refundable* (cash paid − already refunded, scoped to the attendee)
   is ≥ the amount, so **repeat partial refunds can never exceed what was paid**
   (§7.3) without relying on `reverses_id`.

> **New-attendee id resolution.** On the paid-creation path the attendee row id
> isn't known until its `INSERT` runs (the existing batch refers to it via a
> `(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)` subquery,
> `create.ts:210`). So for *that* batch the host uses a token-resolved insert
> variant where the `attendee` account id is that subquery, not a bound literal.
> The library's literal-binding descriptors cover every other call site; the host
> glue (§6.3) owns the token-resolved variant so the library stays generic.

### 4.8 The persistence port (`ports.ts`) — interface only

```ts
export interface LedgerStore {
  byAccount(account: AccountRef, range?: DateRange): Promise<Transfer[]>;
  byReference(reference: string): Promise<Transfer | null>;
  byEventGroup(eventGroup: string): Promise<Transfer[]>;
  byKind(kind: string, range?: DateRange): Promise<Transfer[]>;
  inPeriod(range: DateRange): Promise<Transfer[]>;
  reversalOf(originalId: number): Promise<number | null>;
}
```

### 4.9 Reconciliation (`reconcile.ts`) — pure, *non-tautological*

`Σ balance == 0` proves nothing (§3). Real checks compare the ledger to the
outside world, and group **by event, not by leg kind**:

```ts
/** PSP account vs the provider's reported balance — real drift detector. */
export const reconcileExternal =
  (acct: AccountRef, providerReported: number) => (transfers: Transfer[]) => {
    const diff = balanceOf(acct)(transfers) - providerReported;
    return { diff, ok: diff === 0 };
  };

/** Per-EVENT leg-count check. Groups by `eventGroup` (the shared event id), so a
 *  booking that's missing its fee or payment leg is detectable — splitting on the
 *  reference prefix would wrongly lump every "sale" leg across all bookings. */
export const expectLegCounts =
  (expected: (kindsInGroup: string[]) => number) => (transfers: Transfer[]) => {
    const groups = new Map<string, string[]>();
    for (const t of transfers) {
      const arr = groups.get(t.eventGroup) ?? [];
      arr.push(t.kind ?? "");
      groups.set(t.eventGroup, arr);
    }
    const bad: { eventGroup: string; got: number; want: number }[] = [];
    for (const [g, kinds] of groups) {
      const want = expected(kinds);
      if (want > 0 && kinds.length !== want) bad.push({ eventGroup: g, got: kinds.length, want });
    }
    return bad;
  };
```

Plus the migration **parity oracle** (§12).

---

## 5. Persistence: the `transfers` table

Added to `SCHEMA` in `src/shared/db/migrations/schema.ts`.

```ts
[
  "transfers",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["reference", "TEXT NOT NULL"],   // opaque HMAC/UUID — never a provider id (§8)
      ["event_group", "TEXT NOT NULL"], // shared across one event's legs (§4.9)
      ["source_type", "TEXT NOT NULL"], ["source_id", "TEXT NOT NULL"],
      ["dest_type", "TEXT NOT NULL"], ["dest_id", "TEXT NOT NULL"],
      ["amount", "INTEGER NOT NULL CHECK (amount > 0)"],
      ["currency", "TEXT NOT NULL"],
      ["occurred_at", "TEXT NOT NULL"], ["recorded_at", "TEXT NOT NULL"],
      ["kind", "TEXT NOT NULL DEFAULT ''"],
      ["memo", "TEXT NOT NULL DEFAULT ''"],
      ["reverses_id", "INTEGER"],       // void/correction link only (§7.3, §10)
      ["posted_by", "TEXT NOT NULL DEFAULT 'system'"],
    ],
    indexes: [
      { columns: ["reference"], name: "idx_transfers_reference", unique: true },
      // At most ONE void per original. SQLite treats NULLs as distinct, so the
      // many non-void rows (reverses_id IS NULL) don't collide. NOTE: refunds do
      // NOT set reverses_id (they'd need many rows per original) — see §7.3.
      { columns: ["reverses_id"], name: "idx_transfers_reverses_id", unique: true },
      { columns: ["event_group"], name: "idx_transfers_event_group" },
      { columns: ["source_type", "source_id"], name: "idx_transfers_source" },
      { columns: ["dest_type", "dest_id"], name: "idx_transfers_dest" },
      { columns: ["occurred_at"], name: "idx_transfers_occurred_at" },
      { columns: ["kind"], name: "idx_transfers_kind" },
    ],
  },
],
```

Notes: `id` is TEXT for accounts (opaque to the library); **no FKs** (§8 wants no
cascade from `attendees`); **no money triggers** (balances derived; any future
cache is ledger-rebuilt with a recalculation endpoint); `recorded_at` via
`nowIso()`.

---

## 6. The host glue (`src/shared/accounting/`) — chart of accounts & event mappers

```
accounts.ts  refs.ts  store.ts  events.ts  report.ts  display.ts
```

### 6.1 Chart of accounts (`accounts.ts`)

```ts
export const ACCT = {
  ATTENDEE: "attendee",       // row-backed: attendees.id — the receivable
  DEPOSITS: "deposits",       // singleton liability: deposits held (later, §15)
  EXTERNAL: "external",       // singleton: outside world (cards, bank)
  FEE_INCOME: "fee_income",   // singleton income: the operator's booking fee
  FEES_PAID: "fees",          // singleton expense: provider fees we pay (later)
  MODIFIER: "modifier",       // row-backed: modifiers.id — discount/surcharge
  PSP: "psp",                 // id = "stripe" | "square" | "sumup" (later)
  REVENUE: "revenue",         // row-backed: listings.id — gross ticket sales
  WRITEOFF: "writeoff",       // singleton contra-revenue: comps / write-offs
} as const;

export const WORLD = account(ACCT.EXTERNAL, "world");
export const BOOKING_FEE_INCOME = account(ACCT.FEE_INCOME, "booking");
export const WRITEOFF_COMP = account(ACCT.WRITEOFF, "comp");
export const DEPOSITS_HELD = account(ACCT.DEPOSITS, "held");
export const psp = (p: "stripe" | "square" | "sumup") => account(ACCT.PSP, p);
export const attendeeAcct = (id: number) => account(ACCT.ATTENDEE, id);
export const revenueOf = (listingId: number) => account(ACCT.REVENUE, listingId);
export const modifierAcct = (modifierId: number) => account(ACCT.MODIFIER, modifierId);
```

### 6.2 Opaque references & event groups (`refs.ts`)

References must be **deterministic** (replay regenerates them → unique index
dedupes) yet **non-reversible** (a retained, post-erasure row leaks no provider
id, §8). We reuse the app's HMAC blind-index primitive (behind `ticket_token_index`,
`code_index`, …). The **`eventGroup` is the shared per-event HMAC**; each leg's
`reference` is that group plus a leg slot:

```ts
import { blindIndex } from "#shared/crypto/blind-index.ts";

/** One event group id (booking/refund/settlement), opaque. */
export const eventGroupOf = (kind: string, ...parts: string[]): Promise<string> =>
  blindIndex([kind, ...parts].join("|"));

/** A leg reference within an event group. */
export const legRef = (eventGroup: string, slot: string): string => `${eventGroup}:${slot}`;
```

So all legs of one booking share `eventGroup`, and the leg-count check (§4.9)
groups on it — detecting a booking that lost its fee or payment leg. The slot
(`sale-45`, `fee`, `pay`, `refundcash-1`, …) keeps each leg independently
idempotent.

### 6.3 Adapter (`store.ts`)

Implements `LedgerStore` (narrow selects), plus `transferStatements(drafts)`
(validate + literal-insert descriptors for the host batch) and a
**`newAttendeeLegStatements(drafts, ticketTokenIndex)`** that emits the
**token-resolved** variant for the creation batch (attendee account id = the
`ticket_token_index` subquery, §4.7). The order is all-or-nothing (§7.1), so the
legs need no per-booking guard — a rolled-back order's legs are deleted as a group
by `eventGroup` (§8.2). Admin/backfill use `postTransfers` (own batch).

---

## 7. Mapping every money event to transfers

### 7.1 Paid booking (with fee) — all-or-nothing

The order is **all-or-nothing**, and already is today: `createAttendeeAtomicImpl`
greedily commits the bookings that fit, but its wrapper `ensureAllBookings`
(`create.ts:44-69`) immediately rolls the *whole* order back — `deleteAttendee` +
reverse the order-activity — and returns `capacity_exceeded` if *any* line didn't
fit, after which the webhook refunds the full charge. So the committed state is
always the entire cart or nothing. (A pre-submit capacity check rejects most full
carts up front; `ensureAllBookings` is the authoritative commit-time guarantee
against the check-to-commit race.)

That keeps the ledger path simple: post **all** of an order's legs in the create
batch under one `eventGroup` (each leg resolves the just-inserted attendee id via
the same `ticket_token_index` subquery the booking inserts use, §4.7); on the
all-or-nothing rollback, delete that order's transfers **by `eventGroup`**. There
is no shortfall and no per-line refund to model — the round-2 "shortfall refund /
per-booking-guarded cash leg" machinery is therefore *dropped*.

One subtlety to get right (§8.2): the rollback calls `deleteAttendee`, but the
**erasure** path also calls `deleteAttendee` and must *preserve* transfers. So the
two must be split — `deleteAttendee` never touches transfers; the order-rollback
site (`ensureAllBookings`) deletes the order's transfers by `eventGroup`
explicitly. Getting this backwards either strands rolled-back legs or erases a
real attendee's financial record.

For a clean single £50 ticket + £2 fee (£52 charged):

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 5000 | `sale` |
| `attendee:88` | `fee_income:booking` | 200 | `fee` |
| `external:world` | `attendee:88` | 5200 | `payment` |

`balanceOf(attendee:88)` = 0. All three legs share one `eventGroup`; all join the
creation + `paidBookingFinalizeStatement` batch (§9.2).

### 7.2 Deposit + later balance settlement (guarded, refund-on-reject)

Deposit posts `sale`/`fee` legs (full gross) + a partial `world→attendee` deposit
leg; outstanding is derived. **Settlement keeps a live guard**: the
`world→attendee` balance leg is a `guardedInsertOnBalance` (§4.7) that posts only
while `balanceOf(attendee)` still equals the expected pre-settlement value, so two
concurrent balance sessions can't both credit.

**Critical:** if the guard rejects (0 rows) but the provider already charged,
**refund the customer and record a terminal failure** (`markSessionFailed`) — do
*not* silently no-op, which would strand real money. This mirrors today's
`settleAttendeeBalance` amount-mismatch → refund path.

### 7.3 Refund — reverses original legs; over-refund-guarded; ledger-only partials

A refund **reverses the constituent legs** (revenue/fee/modifier) and returns
cash. It does **not** use `reverses_id` (that's a one-time void link; repeat
partial refunds need many rows per original). Refund legs are tied to the order by
`eventGroup`; the cash leg is over-refund-guarded.

Full refund of the £52 order:

| source | destination | amount | kind | guard |
| --- | --- | --- | --- | --- |
| `revenue:45` | `attendee:88` | 5000 | `refund_reversal` | — |
| `fee_income:booking` | `attendee:88` | 200 | `refund_reversal` | — |
| `attendee:88` | `external:world` | 5200 | `refund_cash` | remaining refundable ≥ 5200 |

- **Two kinds** so reports don't double-count: reversal legs un-recognise;
  the single `refund_cash` leg is the money returned. Refund totals sum **only
  `refund_cash`** (§11).
- **Repeat partial refunds** add more reversal + `refund_cash` legs; the
  `guardedRefundCash` insert ensures cumulative `refund_cash` ≤ cash paid for the
  attendee (so £30 then £20 on a £100 order is fine; a third £60 is rejected).
- **Provider side:** today `refundPayment(ref): Promise<boolean>` is amountless
  (`payments.ts:254-259`) — it can only refund the *whole* charge. So **partial
  refunds are ledger-only for now** (recorded in the ledger; no provider call for
  the partial amount); a full refund still calls the provider. The planned
  amount-aware API (`refundPayment(ref, amount?)`, §15.9) will let partial refunds
  reach the provider too — the ledger shape already supports it.

### 7.4 Modifier discount / 7.5 surcharge

Discount: `modifier:7 → attendee` (modifier funds the attendee). Surcharge/add-on:
`attendee → modifier:9`. `balanceOf(modifier:M)` = today's signed `total_revenue`.
**Direction is captured by which way the leg points and stored immutably** — no
sign ambiguity going forward (unlike `amount_applied`).

### 7.6 Pay-what-you-want — the `sale`/`payment` legs are the chosen amount.

### 7.7 Manual adjustment / comp / cash (admin)

- **Cash received** (e.g. door cash): `external:world → attendee:88` (`manual`).
- **Comp / write-off**: `writeoff:comp → attendee:88` (`comp`) — **not** from
  `external:world`. A comp clears the attendee's balance but is **not cash**;
  routing it through the write-off (contra-revenue) account keeps cash reports
  (which sum `world→*`) from counting comps as money received.

Always `posted_by = user:<id>` + `memo`.

### 7.8 Provider fees & payouts (later) — `world→psp→attendee`, then `psp→fees`, `psp→world`; `balanceOf(psp)` reconciles against the provider.

### 7.9 Summary

| Event | Transfer(s) | Replaces |
| --- | --- | --- |
| Booking (paid) | whole-order `sale`(+`fee`) + `payment`, one `eventGroup` (all-or-nothing) | `price_paid` + income trigger (adds fee tracking) |
| Deposit / balance | sale/fee legs + (guarded) `world→attendee` | `remaining_balance` + fold |
| Refund (any amount) | reverse legs + guarded `refund_cash` | `refunded` flag |
| Discount / surcharge | `modifier→attendee` / `attendee→modifier` | `modifier_usages` money |
| Comp / write-off | `writeoff→attendee` | activity-log free text |
| Cash / manual | `world→attendee` (or any) | activity-log free text |

---

## 8. Attendee deletion & data retention

### 8.1 Transfers are PII- *and provider-id*-free

A row has only account `(type,id)` pairs, an amount, a currency, timestamps, a
`kind`, `event_group`, an **opaque HMAC `reference`**, and `posted_by`. **No
names/emails/phones, no payment-intent or checkout-session ids.** Provider ids
stay in the encrypted `pii_blob` (erased with the attendee). `memo` is PII-free by
house rule (encrypted by the host if it ever must hold sensitive text). So
retaining transfers after erasure is privacy-safe.

### 8.2 Two deletion semantics — split at the call site

Both go through `deleteAttendee` today, so the split is the thing to get right:

1. **Order rollback** (an all-or-nothing cart that didn't fully fit, §7.1): the
   *rollback site* (`ensureAllBookings`) deletes that order's transfers **by
   `eventGroup`**, alongside the `deleteAttendee` it already calls. The order never
   economically happened, so its legs go with it.
2. **Erasure of a real attendee** (GDPR): **`deleteAttendee` itself MUST NOT touch
   transfers.** PII goes; transfers stay, referencing a dangling `attendee:<id>`
   tombstone rendered as "deleted attendee #<id>". Today's delete-time
   `listings.income` recompute (`delete.ts:23`) is removed — income is
   ledger-derived and the revenue legs deliberately remain.

So `deleteAttendee` is transfer-agnostic (erasure-safe by default), and the
rollback path does the scoped `eventGroup` cleanup. Mixing these up either strands
rolled-back legs or erases a real financial record.

### 8.3 The no-FK convention means no cascade can take the ledger with it.

### 8.4 Attendee merge re-points the receivable account

Merge (`merge/attendee-merge.ts`) re-points a source attendee's `listing_attendees`
onto the target and then deletes the source attendee. For the ledger, the source's
receivable account (`attendee:source`) and all its legs must move to
`attendee:target`, or the merged-in money is orphaned on a deleted account and the
target's outstanding balance is wrong.

This is the **one sanctioned exception to immutability**: within the merge batch we
**re-point account ids** — `UPDATE transfers SET source_id = :target WHERE
source_type='attendee' AND source_id=:source` (and the same for `dest_id`). It's a
deliberate, audited account-key rewrite (not an amount/edit), confined to merge,
logged to `activity_log`. After it, `byAccount(attendeeAcct(target))` returns the
combined history and `−balanceOf(attendee:target)` is the combined outstanding.
(Alternative considered and rejected: posting `attendee:source → attendee:target`
balance-moving legs — that moves the *balance* but leaves the *history* split
across a tombstone, which defeats the per-attendee ledger view on the edit page.)

### 8.5 Outstanding balance is live (existing attendees only); reports aggregate by `revenue:<listing>`/kind/time, unaffected by erasure.

---

## 9. Idempotency & concurrency

### 9.1 References

Opaque HMAC `reference` per leg (`<eventGroup>:<slot>`, §6.2) with a `UNIQUE`
index + `ON CONFLICT DO NOTHING`; replays regenerate the same string and no-op.
`event_group` ties an event's legs together for leg-count checks (§4.9).

### 9.2 Same-batch atomicity — incl. a *paid-booking* finalize (prerequisite)

Transfer inserts share the **same batch** as attendee creation **and** the
`processed_payments` finalize. Accuracy point from review: the **paid** path
currently finalizes *separately* (`processReservedSession` → a standalone
`finalizeSession` `UPDATE`); only the *balance* path batches it
(`balanceFinalizeStatement`). So Phase 1 has a **prerequisite refactor**:
introduce `paidBookingFinalizeStatement` and run creation + finalize +
token-resolved transfer inserts in one batch. Because the order is all-or-nothing
(§7.1), there is no half-fulfilled state: a crash leaves nothing partial, and a
rolled-back order's legs are deleted by `eventGroup` in `ensureAllBookings` (§8.2).

### 9.3 Guards

Booking legs dedupe by reference; refund legs self-guard (cumulative over-refund).
Balance settlement uses the account-scoped compare-and-post (§7.2) and **refunds
on guard-reject**. No in-place balance mutation ⇒ no other write contention.

---

## 10. Admin view & adjusting the historical record

### 10.1 Append-only; corrections are first-class

Posted transfers are immutable. Operator actions, all `posted_by = user:<id>` +
required `memo`:

1. **Void / reverse** → `reverseOf(t)` (§4.6), **guarded to once** by unique
   `reverses_id` (§5).
2. **Correct** → `reverseOf(old)` + a new corrected transfer, one batch, linked by
   `reverses_id`.
3. **Manual post** → arbitrary `source → destination` (cash, comp via write-off,
   opening balance).

Refunds are **not** voids (§7.3) and don't consume the `reverses_id` slot.

### 10.2 One shared ledger renderer, used everywhere

A single `renderTransferList(transfers)` (a typed schema → markup function, per
`AGENTS.md`'s schema-over-organic-structure rule — **zero duplication**) is the
*only* place a ledger is formatted. It backs:

- **`/admin/accounting`** — the full historical ledger list (filter by account /
  date / kind; period totals from `inPeriod` + `allBalances`).
- **The edit-attendee page** — that attendee's full ledger
  (`byAccount(attendeeAcct(id))` → the legs touching them, with derived
  outstanding), **rendered with the exact same component/format as the historical
  list**. This is a first-class requirement: the operator sees the same money view
  inline on the attendee they're editing as on the global list. It stays read-only
  and still resolves for a tombstoned/erased attendee.
- **Account statement** — `statementFor(account)` (sorted, running balance).

### 10.3 Reconciliation & editing the record

Reconciliation uses the **non-tautological** checks (§4.9) — `reconcileExternal`
(PSP vs provider) and `expectLegCounts` (per-event) — **not** `Σ balance == 0`
alone.

Adjustments default to corrections (10.1). A **destructive edit of an individual
entry is available** on `/admin/accounting` (which also shows recent transactions
and stats), but the entry's edit page makes it loud: it warns that *this breaks
your permanent, otherwise-flawless record, that you should have a very good
reason, and that you almost certainly want to add an adjustment to the attendee
ledger instead* — actively steering the operator toward a correction. When an edit
removes sensitive content (e.g. a mis-entered memo), the `activity_log` entry
records the **actor, transfer id, and redacted field name/hash — never the
original value** (logging it raw would just re-copy the sensitive text into
another retained table). Any edit re-runs reconciliation.

---

## 11. Reporting unlocked

- **Net revenue / period:** `inPeriod` over `revenue:*`, `modifier:*`,
  `fee_income:*`; sum `allBalances`.
- **Refunds / period:** `sumOfKind("refund_cash", …)` — cash leg only (a £20
  refund counts £20, not £40).
- **Per-listing gross:** `balanceOf(revenueOf(L))`.
- **Outstanding:** per live attendee `−balanceOf(attendeeAcct(A))`.
- **Cash vs recognised:** `world→*` cash legs vs `*→revenue` legs ⇒ receivables
  gap. (Comps excluded from cash because they come from `writeoff`, §7.7.)
- **Provider reconciliation:** `reconcileExternal(psp(p), reported)`.
- **Modifier revenue:** `balanceOf(modifierAcct(M))`.

Headline "take in / refund / net between X and Y" → a one-liner. Flat journal CSV
for accounting-software hand-off.

---

## 12. Migration plan

### Phase 0 — Library + table, zero behaviour change
Pure `src/shared/ledger/` + full tests; add `transfers` to `SCHEMA`; build
`src/shared/accounting/` (chart, refs, store, mappers), not yet called.

### Phase 1 — Prereq refactor, then dual-write + backfill
- **Prerequisites:** `paidBookingFinalizeStatement` folded into the creation batch
  (§9.2); token-resolved legs + `eventGroup` rollback cleanup in `ensureAllBookings`
  (§7.1, §8.2).
- Dual-write transfers in the booking-creation, balance-settlement (guarded,
  refund-on-reject), refund (reversal + guarded cash), modifier, and **merge**
  (re-point account ids, §8.4) paths. Old columns stay source of truth.
- **Backfill** (best-effort, honest caveats):
  - bookings/deposits → `sale`/`fee` + a `payment` leg from `price_paid` (the
    deposit/balance split and dates are unrecoverable — one payment leg).
  - modifiers → direction reconstructed from the modifier's **current** config
    (may be wrong if later edited / row deleted) → best-effort; flag the
    unrecoverable for manual review; immutable direction forward (§7.4).
  - refunds → from `refunded` flags (amount from `price_paid`; date unknown).
- **Parity oracle (reservation- & refund-aware).** `listings.income` is
  `SUM(price_paid)` = **amount paid** (deposit for open reservations; *still
  counts refunded rows*; *excludes* outstanding). So compare it to the **total
  cash-in legs** (`payment`+`deposit`+`balance`), **not** the gross sale legs —
  a live reservation would otherwise look like a mismatch. Check **outstanding**
  (`−balanceOf(attendee)` vs `remaining_balance`) and **refunds** (`refund_cash`
  sum) separately. Per-listing income parity is *not* attempted (the ledger tracks
  per-listing gross + per-attendee cash); total cash parity + the two side checks
  are the oracle. Run until green on real data.

### Phase 2 — Migrate reads to the ledger; add reports (§11) and the shared admin
view (§10.2, incl. the edit-attendee ledger). Old columns become parity oracle.

### Phase 3 — Retire every redundant money column + trigger (§14); replace the
settle fold with the guarded append; demote `modifier_usages` to a stock ledger.

Each phase is a PR passing `deno task precommit`.

---

## 13. Testing strategy

**Pure library:** table-driven validation; property/metamorphic (`balanceOf == Σ
in − Σ out`; `reverseOf` nets to zero; buckets partition; order-independence;
mixed-currency throws; `statementFor` sorted; `sumOfKind("refund_cash")` counts a
£20 refund once; `expectLegCounts` groups by event). 100% coverage from purity.

**Integration** (`#test-utils` + real DB; `server-balance.test.ts` template):
no double-credit on replay; **paid-path atomicity** (crash between create &
finalize ⇒ no orphaned legs); **all-or-nothing rollback** (a 2-listing cart where
one line is full ⇒ the whole order rolls back, *no* transfers remain — deleted by
`eventGroup` — and the full charge is refunded); booking fee
(`balanceOf(attendee)==0`, fee income == £2); **guarded settlement +
refund-on-reject** (two concurrent balance sessions ⇒ credited once, the loser's
charge refunded); **refund correctness** (full refund of a fee+surcharge order
zeroes revenue/fee/modifier; repeat partials guarded so cumulative ≤ paid;
over-refund rejected); reverse-once (double void rejected); comps don't inflate
cash; **merge re-points** (merging two attendees moves the source's legs to the
target — combined outstanding correct, source account empty); **erasure retains
transfers** (no PII/provider id; income unchanged); backfill parity (income ==
total cash legs; outstanding == `remaining_balance`).

**Determinism:** injected `nowIso`/HMAC; every branch a direct in-process test.

---

## 14. What this retires — the definitive removal list

Phase 3 deletes all of these (migrate the listed readers first). **No money column
survives.**

| Removed | Becomes | Readers to migrate first |
| --- | --- | --- |
| `listing_attendees.price_paid` | cash/sale legs | `balance.ts`; `queries.ts` `ATTENDEE_COLS`/detail/list; `atomic-update.ts`; `capacity.ts`; `delete.ts:23`; `attendee-merge.ts`; confirmation email; scanner; CSV; `webhooks.ts` |
| `attendees.remaining_balance` | `−balanceOf(attendee)` | `balance.ts`; `attendee-balance.ts`; public `balance.ts`; webhooks |
| `attendees.price_paid` (in `pii_blob`) | sum of attendee cash legs | `pii.ts:98`; `create.ts:106`; confirmation templates |
| `listing_attendees.refunded` | refund legs / `refund_cash` sum (partials) | `queries.ts`; `atomic-update.ts`; scanner; detail badge; refund guard |
| `listings.income` + income leg of `LISTING_AGGREGATE_TRIGGERS` | `balanceOf(revenueOf(L))` | `stats.ts`; dashboard; CSV; `listings.ts` cache |
| `modifiers.total_revenue` | `balanceOf(modifierAcct(M))` | `modifiers.ts`; modifiers page |
| `modifiers.total_uses`/`usage_count` + `MODIFIER_AGGREGATE_TRIGGERS` | live `COUNT`/`SUM(quantity)` over the stock ledger | modifiers page; recalculation |
| `modifier_usages.amount_applied` | `modifier:M` transfers | `modifier-usage.ts`; webhooks |
| `settleAttendeeBalance` fold (`balance.ts:180-183`) | guarded `world→attendee` append | — |
| money lines in `activity_log` | structured transfers (+ human summary stays) | refund/balance log sites |

**Kept (not money):** `quantity`/`booked_quantity`/`tickets_count` + the capacity
part of the listing trigger; `modifier_usages` rows as the stock ledger;
`unit_price`/`day_prices`/`max_price`/`can_pay_more`/`reservation_amount` (pricing
config).

---

## 15. Decisions (resolved)

1. **All-in, no parallel money state** (§14); any future cache is ledger-rebuilt.
2. **Recognition at sale, gross**; modifiers/fee via own accounts. Deferred accrual is later (`DEPOSITS` reserved).
3. **Booking fee is income** (`fee_income:booking`); cash leg == amount charged.
4. **Single currency, enforced in code** (`assertSingleCurrency`, §4.5).
5. **Balance settlement keeps a live guard** and **refunds on guard-reject** (§7.2) — never a silent no-op.
6. **References are opaque HMACs**, never provider ids (§6.2/§8); each event's legs share an `event_group`.
7. **Paid-path finalize must be batched** with creation + token-resolved ledger inserts — a Phase-1 prerequisite (§9.2), because the paid path finalizes separately today.
8. **Refunds reverse the original legs** + one guarded `refund_cash`; they do **not** use `reverses_id`; reports sum `refund_cash` only.
9. **Partial refunds are ledger-only for now**; full refunds call the provider. An amount-aware provider API (`refundPayment(ref, amount?)`) is the planned path to provider-side partials — the ledger already supports it.
10. **At most one *void* per original** (unique `reverses_id`); refunds tracked via `event_group` + over-refund guard.
11. **Comps/write-offs come from a `writeoff` contra-revenue account**, not external cash, so cash reports stay honest.
12. **`modifier_usages` stays as a stock ledger** (money stripped).
13. **`Σ balance == 0` is a sanity check only**; reconcile against provider balances and per-event leg counts (§4.9).
14. **Corrections are the default**; a destructive entry edit *is* available on `/admin/accounting`, but the edit page warns it breaks the permanent record and steers the operator to an attendee-ledger adjustment instead; sensitive-content edits **log redacted**, never the raw value (§10.3).
15. **One shared ledger renderer** for the historical list, the account statement, **and the edit-attendee page** (§10.2).
16. **Carts are all-or-nothing** — already true via `ensureAllBookings` (§7.1). Order legs ride the create batch under one `eventGroup` and are deleted as a group on rollback; no shortfall / per-booking machinery.
17. **Attendee merge re-points the receivable account** — the single sanctioned mutation of account ids, confined to the merge batch and logged (§8.4).

---

## 16. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Partial-fit order leaves stray legs | High | Order is all-or-nothing (§7.1): whole-order rollback deletes legs by `eventGroup` in `ensureAllBookings` (§8.2); rollback test. |
| Merge orphans the source attendee's ledger | High | Merge re-points account ids in-batch — the one sanctioned mutation (§8.4); merge test. |
| `deleteAttendee` used for both rollback and erasure | High | Split: `deleteAttendee` is transfer-agnostic (erasure-safe); rollback site does the scoped `eventGroup` delete (§8.2). |
| Attendee id unknown at insert ⇒ post-creation writes lose atomicity | High | Token-resolved insert variant in the creation batch (§4.7/§6.3). |
| Paid-path finalize not batched ⇒ orphaned legs / double attendee | High | `paidBookingFinalizeStatement` prerequisite (§9.2); crash-between test. |
| Guarded-out balance payment strands a real charge | High | Refund + terminal-failure on guard-reject (§7.2); concurrent-settlement test. |
| Provider ids retained past erasure | High (privacy) | HMAC references; provider ids only in encrypted `pii_blob`; retention test. |
| Booking fee unaccounted | High | `fee_income` leg; cash == charged; fee test. |
| Repeat partial refunds exceed paid / collide with void slot | High | `guardedRefundCash` cumulative guard; refunds don't use `reverses_id` (§7.3). |
| Refund double-count / stranded accounts | Medium | Reverse original legs; `refund_cash`-only totals. |
| Comps counted as cash | Medium | `writeoff` account (§7.7). |
| Mixed-currency silent sums | Medium | `assertSingleCurrency` (§4.5). |
| Leg-count check grouped by kind, not event | Medium | `event_group` grouping (§4.9). |
| Unsorted statement running balances | Low | `statementFor` sorts (§4.5). |
| Parity oracle false mismatch (reservations/refunds) | Medium | Compare income to total cash-in legs; separate outstanding/refund checks (§12). |
| Hard-edit log re-copies sensitive memo | Medium | Log redacted field/hash only (§10.3). |
| Modifier backfill misclassifies old direction | Medium (accepted) | Best-effort from config; flag for review; immutable forward. |
| `Σ balance == 0` mistaken for reconciliation | Medium | Documented tautological; real checks (§4.9). |
| Guard subquery O(ledger) scan on hot path | Medium | Account-scoped guard subquery using source/dest indexes (§4.7). |
| Cascade deletes a tombstone's transfers | High | No FKs; erase never touches `transfers`; rollback by `event_group`. |

---

## 17. Review findings folded in

**Round 1 (12, all valid):** booking-fee leg; HMAC references; paid-path finalize
batching; balance-settlement guard; distinct refund kinds; refund reverses
original legs; partial-refund vs amountless provider API; mixed-currency guard;
one-void guard; gross-vs-net parity oracle; modifier-direction backfill; tautological
conservation check.

**Round 2 (10, all valid — two P1 code-claims verified against `create.ts`):**

- **P1 — greedy capacity** (partial-fit commits): resolved by the order being
  all-or-nothing — whole-order rollback deletes legs by `eventGroup` (§7.1, §8.2).
- **P1 — attendee id unknown at insert**: token-resolved insert variant
  (§4.7, §6.3).
- **P1 — guarded-out balance payment strands a charge**: refund + terminal
  failure (§7.2).
- **P1 — repeat partial refunds vs unique `reverses_id`**: refunds use
  `event_group` + `guardedRefundCash`, not `reverses_id` (§7.3, §5).
- **P2 — leg-count grouped by kind**: group by `event_group` (§4.9, §6.2).
- **P2 — guard subquery full scan**: account-scoped subquery (§4.7).
- **P2 — comps counted as cash**: `writeoff` account (§7.7).
- **P2 — parity oracle vs reservations**: compare income to total cash legs (§12).
- **P2 — unsorted statements**: `statementFor` sorts (§4.5).
- **P2 — hard-edit log leaks memo**: log redacted only (§10.3).

**Round 3 (owner decisions):** carts confirmed **all-or-nothing** (already true via
`ensureAllBookings`) — simplifies the create path, dropping the per-booking /
shortfall machinery; **attendee-merge** handling added (re-point account ids — the
one sanctioned immutability exception, §8.4); destructive entry edits **available**
with a strong steer-to-adjustment warning (§10.3); **partial refunds ledger-only**
for now; the **edit-attendee page reuses the shared ledger renderer** (§10.2).

---

### One-paragraph summary

A single append-only `transfers` table moves positive amounts between typed
accounts — with the attendee modelled as a receivable so "paid" and "owed" are
derived — fronted by a pure, context-free library (`src/shared/ledger/`) doing
currency-guarded projection, non-tautological reconciliation, sorted statements,
reversals, and statement-descriptor batching (plain, balance-guarded, and
refund-guarded), driven by a thin host glue holding the chart of accounts (incl.
booking-fee income and a write-off account for comps), opaque HMAC references with
per-event groups, and event mappers that post whole-order, token-resolved legs
inside the finalize batch (carts are all-or-nothing). Income, outstanding, amount-paid, refunds, and
modifier revenue all become `SUM` over the ledger and every redundant money column
+ trigger is deleted; transfers are PII/provider-id-free and survive attendee
erasure; one shared renderer shows the same ledger on the global list and the
edit-attendee page (one shared renderer); attendee merge re-points the receivable
account; partial refunds are ledger-only until an amount-aware provider API lands.
The load-bearing prerequisite is batching the paid-booking finalize with
token-resolved ledger inserts — without it a replay corrupts the books.
