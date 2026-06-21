# Double-Entry Accounting — Design Doc

A plan to replace the platform's scattered, mutable money state with a single
append-only **transfer ledger**, fronted by a small, pure, context-free
accounting library that the rest of the system hooks into.

We go **all-in**: the ledger becomes the single source of truth for 100% of
accounting. Every column that records money is removed once its reads are
migrated — no parallel money state, no "cache that's also a source of truth".

Status: **proposal**. Nothing here is built yet. This doc is the thing to argue
with before any code is written. (It has already had one round of adversarial
review folded in — see §17 for the resolved findings.)

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
  timestamped row describing a transfer from one account to another. Nothing
  financial lives anywhere else.
- **Balances become derived, never stored.** Income, outstanding balances,
  refund totals, amount-paid, modifier revenue — all become `SUM` over the
  ledger. The denormalised money columns and their triggers are deleted (§14).
- **A pure, unit-testable accounting library** with zero knowledge of tickets,
  attendees, or Stripe. It knows accounts, transfers, balances, and invariants.
  The app maps its domain onto the library; the library never maps back.
- **The financial record outlives the people in it.** Deleting an attendee
  (erasure / GDPR) must not delete the money that moved. Transfers are PII-free
  *and provider-identifier-free* and survive.
- **An admin view** to inspect the ledger and adjust the historical record —
  safely, by appending corrections, never by destructive edits.

### Non-goals (for the first version)

- A user-editable chart of accounts. The chart is a small set of code constants.
- Tax computation. (Tax, if ever needed, is just another account.)
- Multi-currency *operation*. The `currency` column exists from day one, but the
  app stays single-currency per site and the library **enforces** that by
  refusing to sum across currencies (§4.5).
- Automated provider-fee/payout import. The model *supports* fees and payouts
  (§7.8); wiring real Stripe/Square fee data in is a later phase that adds no new
  schema.

---

## 2. Why — what we have today and why it hurts

Money today is **mutable state spread across four independent mechanisms**, each
maintained by its own bespoke trigger/code:

| Where | What it stores | The pain |
| --- | --- | --- |
| `listing_attendees.price_paid` → `listings.income` (3 triggers, `schema.ts:111-113`, `823-871`) | per-line amount, summed to a lifetime `income` column | all-time only — **no date dimension**; refunded rows still counted |
| `attendees.remaining_balance` (`schema.ts:277`) + `settleAttendeeBalance` (`balance.ts:152-212`) | outstanding deposit balance | a balance payment is **folded into the earliest line's `price_paid`** (`balance.ts:180-183`) — the deposit-vs-balance split and its timestamps are destroyed |
| `listing_attendees.refunded` 0/1 flag (`schema.ts:313`) | "was this refunded" | **no amount, no date**; partial and repeat refunds are impossible |
| `modifier_usages.amount_applied` + 3 triggers + `modifiers.total_revenue`/`total_uses`/`usage_count` (`schema.ts:516-531`, `885-933`) | discount/surcharge money + counts | already an append-only ledger — just a *separate* one, for one slice of money |

The decisive consequence: **an operator cannot answer "what did I take in,
refund, and net over date range X?"** The data to answer it isn't stored in
queryable form. Refund amounts are never recorded; income has no time axis;
the deposit/balance history is overwritten on settlement; and the **booking fee
charged at checkout is never recorded per booking at all** (it's added to the
provider charge via `feeExtras` in `checkout-pricing.ts` but not stored).

Two things make this a *low-novelty* change rather than a leap:

1. **The pattern already exists in-house, twice.** `modifier_usages` is an
   append-only ledger with guarded atomic inserts (`modifier-usage.ts:38-85`),
   trigger-maintained cached aggregates, *and* a recalculation/audit endpoint
   (`features/admin/aggregate-recalculation.ts`). The transfer ledger is that
   exact pattern, generalised to all money.
2. **Amounts are already plaintext integer minor units** (`currency.ts`), and
   `attendee_id` / `listing_id` are already plaintext FKs. So a ledger of
   amounts keyed by those ids introduces **no new encryption design** — provided
   the row carries no provider identifiers (§8).

This also lands squarely on three house principles from `AGENTS.md`:

- **"Schema over organic structure / make invalid arrangements
  unrepresentable."** A single source→destination row *cannot* be unbalanced.
- **"Trust application invariants… if an impossible state is observed, raise an
  error."** Reconciliation against source records (§4.9) catches drift.
- **"Malleable software… repairing data should be a first-class operator
  action."** The admin adjustment flow (§10) is exactly this.

---

## 3. The core model: transfers between typed accounts

One table. Every row moves a positive `amount` from a **source account** to a
**destination account** at a point in time:

```
transfer:  (source_type, source_id)  ──amount──▶  (dest_type, dest_id)
```

Because each row carries both ends, it is its own balanced double entry: it
credits the destination and debits the source simultaneously. **There is no way
to write half a transaction.**

### Accounts are `(type, id)` — no accounts table

An account is identified by a `type` and an `id`. Some accounts are **row-backed**
(their id is a row id elsewhere — an attendee, a listing, a modifier); some are
**singletons** with hardcoded ids (the outside world, each payment processor, the
booking-fee income bucket). No `accounts` table is required: an account "exists"
exactly when a transfer references it. (A tiny optional metadata map gives
singletons display names — §6.)

### The attendee is an account (this is what lets us delete `price_paid` and `remaining_balance`)

The key modelling move that makes "all-in" possible: **each attendee is a real
account — a receivable / clearing account.** A sale *bills* the attendee; cash
*funds* the attendee. The attendee account's balance is, by construction, exactly
what they still owe (or are owed). This is why we can derive both "amount paid"
and "outstanding balance" from the ledger alone and delete the columns that store
them today.

- **Bill the attendee for the sale** (revenue recognised): `attendee:A → revenue:L`
- **Bill the attendee for the booking fee**: `attendee:A → fee_income:booking`
- **Fund the attendee with cash** (the *full* amount actually charged):
  `world → attendee:A`
- **Outstanding(A) = −balanceOf(attendee:A)** — negative balance means they owe,
  positive means they have credit (overpaid). Fully paid ⇒ balance 0.

### Balances are derived

For any account `A`:

```
balance(A) = SUM(amount where dest = A) − SUM(amount where source = A)
```

### Amounts are positive; direction encodes sign

No negative amounts. A refund is not a negative payment; it is a transfer in the
opposite direction. A discount is the modifier account funding the attendee. This
keeps every row independently meaningful and makes the "unrepresentable invalid
state" guarantee real (a `CHECK (amount > 0)` backs it).

### Recognition basis (a decided point)

Revenue is recognised **at sale** (booking time), matching today's behaviour, via
the `attendee:A → revenue:L` leg at the **gross list price**. Modifiers adjust it
through their own account (§7.4–7.5), so `balanceOf(revenue:L)` is gross sales per
listing and `balanceOf(modifier:M)` is that modifier's net revenue effect
(exactly today's `total_revenue`). The dashboard "income" headline becomes
**recognised net revenue** = `Σ balanceOf(revenue:*) + Σ balanceOf(modifier:*) +
balanceOf(fee_income:booking)`, which equals cash received once everything is
settled and correctly *includes* billed-but-unpaid balances before then. This is
a deliberate, documented shift from today's pure cash-paid number — and a strictly
more useful one. (A full accrual variant that defers recognition to the event
date is a later option, §15.)

> **Conservation note (don't over-trust it).** Because the outside world is a real
> account, `Σ balance(A) == 0` always holds. But that is **structurally
> tautological** for a single-row-balanced ledger — every row adds `+amount` one
> side and `−amount` the other — so it cannot detect a duplicated webhook row, a
> deleted row, or a row posted to the *wrong* account. It is a cheap sanity check,
> not reconciliation. Real integrity comes from reconciling against source records
> and provider balances (§4.9, §10.2).

---

## 4. The library (`src/shared/ledger/`) — pure & context-free

> The library knows accounts, transfers, balances, and invariants. It does **not**
> know what an attendee, a listing, or Stripe is. It imports nothing from the app
> except the generic FP primitives (`#fp`). All time and id generation are
> **inputs**, never effects it performs.

### 4.1 Module layout

```
src/shared/ledger/
  types.ts        # value types: AccountRef, TransferInput, Transfer, errors
  account.ts      # canonical key encoding, equality, helpers (pure)
  validate.ts     # pure validation of a TransferInput -> Result
  project.ts      # pure projections: balances, statements, period buckets, net
  reconcile.ts    # pure reconciliation checks (non-tautological)
  reverse.ts      # pure construction of reversing/adjusting transfers
  statements.ts   # pure: TransferInput -> { sql, args } statement descriptors
  ports.ts        # the LedgerStore interface the host implements (types only)
  mod.ts          # barrel
```

The split that matters: **everything except `ports.ts` is pure and runs without a
database.** `ports.ts` is just an interface. The host wires a libsql adapter to
it in `src/shared/accounting/` (§6).

### 4.2 Value types (`types.ts`)

```ts
/** An account is a (type, id) pair. Both are opaque strings to the library;
 *  the host assigns meaning (see the chart of accounts). Row-backed accounts use
 *  the stringified row id; singletons use a fixed string id. */
export type AccountRef = { readonly type: string; readonly id: string };

/** Positive integer, minor units (pence/cents). The library never divides or
 *  formats — decimal places and rendering are the host's concern. */
export type MinorUnits = number;

/** The data needed to post one transfer. `occurredAt`, `reference`, and any id
 *  generation are supplied by the caller — the library performs no I/O and reads
 *  no clock. `reference` MUST be opaque (an HMAC/UUID), never a provider id (§8). */
export type TransferInput = {
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: MinorUnits;
  readonly currency: string; // ISO-4217, opaque to the library
  readonly occurredAt: string; // ISO timestamp — business time of the event
  readonly reference: string; // idempotency key — opaque, non-reversible
  readonly kind?: string; // host-defined category, opaque (e.g. "refund_cash")
  readonly memo?: string; // PII-free reason (host responsibility, §8)
  readonly reversesId?: number; // id of the transfer this reverses/corrects
  readonly postedBy?: string; // "system" or an admin user id, opaque
};

export type Transfer = TransferInput & {
  readonly id: number;
  readonly recordedAt: string; // when the row was written (vs occurredAt)
};

export type LedgerError =
  | { code: "non_positive_amount" }
  | { code: "non_integer_amount" }
  | { code: "self_transfer" }
  | { code: "empty_account" }
  | { code: "empty_currency" }
  | { code: "empty_reference" };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; errors: LedgerError[] };
```

### 4.3 Account helpers (`account.ts`) — pure

```ts
import type { AccountRef } from "./types.ts";

const SEP = " "; // NUL — cannot appear in a sane type/id

export const accountKey = (a: AccountRef): string => `${a.type}${SEP}${a.id}`;
export const sameAccount = (a: AccountRef, b: AccountRef): boolean =>
  a.type === b.type && a.id === b.id;
export const account = (type: string, id: string | number): AccountRef => ({
  type,
  id: String(id),
});
```

### 4.4 Validation (`validate.ts`) — pure

```ts
import { compact } from "#fp";
import type { LedgerError, Result, TransferInput } from "./types.ts";
import { sameAccount } from "./account.ts";

export const validateTransfer = (t: TransferInput): Result<TransferInput> => {
  const errors: LedgerError[] = compact([
    t.amount <= 0 ? ({ code: "non_positive_amount" } as const) : null,
    !Number.isInteger(t.amount) ? ({ code: "non_integer_amount" } as const) : null,
    sameAccount(t.source, t.destination) ? ({ code: "self_transfer" } as const) : null,
    !t.source.type || !t.source.id || !t.destination.type || !t.destination.id
      ? ({ code: "empty_account" } as const)
      : null,
    !t.currency ? ({ code: "empty_currency" } as const) : null,
    !t.reference ? ({ code: "empty_reference" } as const) : null,
  ]);
  return errors.length ? { ok: false, errors } : { ok: true, value: t };
};
```

### 4.5 Projections (`project.ts`) — pure, the unit-testable jewels

Total, deterministic, side-effect-free. **They refuse to sum across currencies** —
the "single-currency" decision (§15) is enforced here, not merely asserted in
prose, so a backfill, a currency change, or a mis-entered manual transfer can
never silently add pence to cents.

```ts
import { filter, reduce, sumOf, unique } from "#fp";
import { accountKey, sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Throw if a transfer set mixes currencies — the guard behind every balance. */
export const assertSingleCurrency = (transfers: Transfer[]): void => {
  const currencies = unique(transfers.map((t) => t.currency));
  if (currencies.length > 1)
    throw new Error(`mixed-currency ledger slice: ${currencies.join(", ")}`);
};

/** Net balance of a single account: money in minus money out. */
export const balanceOf =
  (acct: AccountRef) =>
  (transfers: Transfer[]): number => {
    assertSingleCurrency(transfers);
    const into = sumOf((t: Transfer) => (sameAccount(t.destination, acct) ? t.amount : 0))(transfers);
    const outOf = sumOf((t: Transfer) => (sameAccount(t.source, acct) ? t.amount : 0))(transfers);
    return into - outOf;
  };

/** Every account's balance, keyed by canonical account key. */
export const allBalances = (transfers: Transfer[]): Map<string, number> => {
  assertSingleCurrency(transfers);
  return reduce((acc: Map<string, number>, t: Transfer) => {
    acc.set(accountKey(t.destination), (acc.get(accountKey(t.destination)) ?? 0) + t.amount);
    acc.set(accountKey(t.source), (acc.get(accountKey(t.source)) ?? 0) - t.amount);
    return acc;
  }, new Map<string, number>())(transfers);
};

/** Sum of one kind's amounts — for reports that count a single leg (§11). */
export const sumOfKind =
  (kind: string) =>
  (transfers: Transfer[]): number => {
    assertSingleCurrency(transfers);
    return sumOf((t: Transfer) => (t.kind === kind ? t.amount : 0))(transfers);
  };

/** Filter to a half-open business-time window [from, to). */
export const inPeriod =
  (from: string, to: string) =>
  (transfers: Transfer[]): Transfer[] =>
    filter((t: Transfer) => t.occurredAt >= from && t.occurredAt < to)(transfers);

export type StatementLine = { transfer: Transfer; signed: number; running: number };

export const statementFor =
  (acct: AccountRef) =>
  (transfers: Transfer[]): StatementLine[] => {
    const lines = filter(
      (t: Transfer) => sameAccount(t.source, acct) || sameAccount(t.destination, acct),
    )(transfers);
    let running = 0;
    return lines.map((transfer) => {
      const signed = sameAccount(transfer.destination, acct) ? transfer.amount : -transfer.amount;
      running += signed;
      return { running, signed, transfer };
    });
  };
```

The host's `LedgerStore` queries are currency-scoped (the app is single-currency,
so in practice every slice is one currency); the guard is the belt-and-braces that
makes a violation loud instead of silent.

### 4.6 Reversals & adjustments (`reverse.ts`) — pure

```ts
import type { Transfer, TransferInput } from "./types.ts";

/** Build the transfer that exactly undoes `t`: same amount, swapped ends. The
 *  caller supplies the new occurredAt/reference/actor so the library stays pure. */
export const reverseOf = (
  t: Transfer,
  meta: { occurredAt: string; reference: string; postedBy: string; kind?: string; memo?: string },
): TransferInput => ({
  amount: t.amount,
  currency: t.currency,
  destination: t.source, // swapped
  kind: meta.kind ?? "reversal",
  memo: meta.memo ?? "",
  occurredAt: meta.occurredAt,
  postedBy: meta.postedBy,
  reference: meta.reference,
  reversesId: t.id,
  source: t.destination, // swapped
});
```

A *correction* is `reverseOf(old)` plus a new corrected `TransferInput`, posted
together in one batch (§10). **At most one reversal per original** is enforced by
the schema (unique `reverses_id`, §5) so a double-clicked void cannot over-reverse.

### 4.7 Statement descriptors (`statements.ts`) — pure, the batching linchpin

The library does **not** open transactions or call the DB. It turns a validated
`TransferInput` into a `{ sql, args }` descriptor — exactly the shape `balance.ts`
and `modifier-usage.ts` already pass to `executeBatchWithResults`. The host drops
these into *its own* atomic batch (alongside the `processed_payments` finalize,
§9), which is what makes hot-path atomicity and idempotency possible without the
library knowing anything about payments.

```ts
import type { InValue } from "@libsql/client";
import type { TransferInput } from "./types.ts";

/** An idempotent insert: ON CONFLICT(reference) DO NOTHING makes a replayed
 *  post a no-op (rowsAffected === 0), mirroring processed_payments dedupe. */
export const insertTransferStatement = (
  t: TransferInput,
  recordedAt: string,
): { sql: string; args: InValue[] } => ({
  args: [
    t.reference, t.source.type, t.source.id, t.destination.type, t.destination.id,
    t.amount, t.currency, t.occurredAt, recordedAt,
    t.kind ?? "", t.memo ?? "", t.reversesId ?? null, t.postedBy ?? "system",
  ],
  sql: `INSERT INTO transfers
          (reference, source_type, source_id, dest_type, dest_id,
           amount, currency, occurred_at, recorded_at, kind, memo, reverses_id, posted_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(reference) DO NOTHING`,
});

/** A *guarded* insert that only posts when an account's current ledger balance
 *  equals `expected` — the ledger-side compare-and-post used for balance
 *  settlement (§7.2) so two concurrent paid callbacks can't both credit the same
 *  outstanding amount. Mirrors the modifier guarded insert (modifier-usage.ts).
 *  The balance subquery is over the same single currency the row carries. */
export const guardedInsertOnBalance = (
  t: TransferInput,
  recordedAt: string,
  guard: { account: { type: string; id: string }; expected: number },
): { sql: string; args: InValue[] } => ({
  args: [
    t.reference, t.source.type, t.source.id, t.destination.type, t.destination.id,
    t.amount, t.currency, t.occurredAt, recordedAt,
    t.kind ?? "", t.memo ?? "", t.reversesId ?? null, t.postedBy ?? "system",
    guard.account.type, guard.account.id, guard.account.type, guard.account.id,
    t.currency, guard.expected,
  ],
  sql: `INSERT INTO transfers
          (reference, source_type, source_id, dest_type, dest_id,
           amount, currency, occurred_at, recorded_at, kind, memo, reverses_id, posted_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (
          SELECT COALESCE(SUM(CASE WHEN dest_type = ? AND dest_id = ? THEN amount ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN source_type = ? AND source_id = ? THEN amount ELSE 0 END), 0)
          FROM transfers WHERE currency = ?
        ) = ?
        ON CONFLICT(reference) DO NOTHING`,
});
```

### 4.8 The persistence port (`ports.ts`) — interface only

```ts
import type { AccountRef, Transfer } from "./types.ts";

export type DateRange = { from?: string; to?: string };

export interface LedgerStore {
  byAccount(account: AccountRef, range?: DateRange): Promise<Transfer[]>;
  byReference(reference: string): Promise<Transfer | null>;
  byKind(kind: string, range?: DateRange): Promise<Transfer[]>;
  inPeriod(range: DateRange): Promise<Transfer[]>;
  /** Reversal id for an original transfer, or null — for the at-most-one check. */
  reversalOf(originalId: number): Promise<number | null>;
}
```

### 4.9 Reconciliation (`reconcile.ts`) — pure, *non-tautological*

`Σ balance == 0` is structural and proves nothing (§3 note). Real integrity is
checked by comparing the ledger to things outside it:

```ts
import { balanceOf } from "./project.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Provider reconciliation: does our PSP account match the provider's reported
 *  balance? A non-zero diff is real drift (missed/duplicate webhook, fee, payout). */
export const reconcileExternal =
  (acct: AccountRef, providerReported: number) =>
  (transfers: Transfer[]): { ok: boolean; diff: number } => {
    const diff = balanceOf(acct)(transfers) - providerReported;
    return { diff, ok: diff === 0 };
  };

/** Per-event leg-count check: every business event must post exactly the legs
 *  its kind requires (e.g. a paid sale = sale + fee? + payment). A duplicated or
 *  missing leg shows up as a wrong count for that reference group. */
export const expectLegCounts =
  (expected: (refGroup: string) => number) =>
  (transfers: Transfer[]): { refGroup: string; got: number; want: number }[] => {
    const byGroup = new Map<string, number>();
    for (const t of transfers) {
      const g = t.reference.split(":")[0] ?? t.reference; // host's group convention
      byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
    }
    const bad: { refGroup: string; got: number; want: number }[] = [];
    for (const [g, got] of byGroup) {
      const want = expected(g);
      if (want > 0 && got !== want) bad.push({ got, refGroup: g, want });
    }
    return bad;
  };
```

Plus the **parity oracle** during migration (§12): ledger-derived numbers vs the
old columns they replace.

---

## 5. Persistence: the `transfers` table

Added to the declarative schema in `src/shared/db/migrations/schema.ts` (the
`SCHEMA` array), so the existing migration/`SCHEMA_HASH` machinery picks it up.

```ts
[
  "transfers",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      // Opaque idempotency key — an HMAC/UUID, NEVER a provider id (§8/§9).
      ["reference", "TEXT NOT NULL"],
      ["source_type", "TEXT NOT NULL"],
      ["source_id", "TEXT NOT NULL"],
      ["dest_type", "TEXT NOT NULL"],
      ["dest_id", "TEXT NOT NULL"],
      // Positive minor units; direction is encoded by source/dest, never sign.
      ["amount", "INTEGER NOT NULL CHECK (amount > 0)"],
      ["currency", "TEXT NOT NULL"],
      // Business time vs record time (differ for backdated/backfilled rows).
      ["occurred_at", "TEXT NOT NULL"],
      ["recorded_at", "TEXT NOT NULL"],
      ["kind", "TEXT NOT NULL DEFAULT ''"],
      ["memo", "TEXT NOT NULL DEFAULT ''"],
      // The transfer this one reverses/corrects (app-enforced, no FK).
      ["reverses_id", "INTEGER"],
      ["posted_by", "TEXT NOT NULL DEFAULT 'system'"],
    ],
    indexes: [
      { columns: ["reference"], name: "idx_transfers_reference", unique: true },
      // At most ONE reversal per original. SQLite treats NULLs as distinct, so
      // the many non-reversal rows (reverses_id IS NULL) don't collide, while a
      // second reversal of the same original is rejected — preventing a
      // double-clicked void from over-reversing (no partial-index syntax needed).
      { columns: ["reverses_id"], name: "idx_transfers_reverses_id", unique: true },
      { columns: ["source_type", "source_id"], name: "idx_transfers_source" },
      { columns: ["dest_type", "dest_id"], name: "idx_transfers_dest" },
      { columns: ["occurred_at"], name: "idx_transfers_occurred_at" },
      { columns: ["kind"], name: "idx_transfers_kind" },
    ],
  },
],
```

Design notes:

- **`id` is TEXT for accounts** (the library treats account ids as opaque). Host
  stores stringified ints for row-backed accounts, fixed strings (`"world"`,
  `"stripe"`) for singletons.
- **No FKs**, per the project's convention (`schema.ts:323-325`) — and §8 explains
  why we *want* the absence of a cascade from `attendees`.
- **No money triggers.** Balances are derived. (Capacity triggers on
  `listing_attendees` stay — they're not money; §14.) Any future cache is
  ledger-rebuilt with a recalculation endpoint, never a second source of truth.
- `recorded_at` is supplied via `nowIso()` (`#shared/now.ts`) at the call site.

---

## 6. The host glue (`src/shared/accounting/`) — chart of accounts & event mappers

```
src/shared/accounting/
  accounts.ts   # chart of accounts: types + singleton ids + ref builders
  refs.ts       # opaque, deterministic reference builder (HMAC blind index)
  store.ts      # libsql adapter implementing LedgerStore + batch helpers
  events.ts     # map domain events (booking/refund/balance/modifier) -> drafts
  report.ts     # report queries (narrow SQL) feeding the pure projections
  display.ts    # singleton display names, account labels for the admin UI
```

### 6.1 The chart of accounts (`accounts.ts`)

```ts
import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";

export const ACCT = {
  ATTENDEE: "attendee", // row-backed: id = attendees.id — the receivable
  DEPOSITS: "deposits", // singleton liability: deposits held (optional, §15)
  EXTERNAL: "external", // singleton: the outside world (cards, bank)
  FEE_INCOME: "fee_income", // singleton income: the operator's booking fee
  FEES_PAID: "fees", // singleton expense: provider fees we pay (later phase)
  MODIFIER: "modifier", // row-backed: id = modifiers.id — discount/surcharge
  PSP: "psp", // singleton-ish: id = "stripe" | "square" | "sumup" (later)
  REVENUE: "revenue", // row-backed: id = listings.id — gross ticket sales
} as const;

// Singletons (the "our Stripe account" pattern)
export const WORLD: AccountRef = account(ACCT.EXTERNAL, "world");
export const BOOKING_FEE_INCOME: AccountRef = account(ACCT.FEE_INCOME, "booking");
export const DEPOSITS_HELD: AccountRef = account(ACCT.DEPOSITS, "held");
export const FEES_PAID: AccountRef = account(ACCT.FEES_PAID, "paid");
export const psp = (p: "stripe" | "square" | "sumup"): AccountRef => account(ACCT.PSP, p);

// Row-backed builders
export const attendeeAcct = (id: number): AccountRef => account(ACCT.ATTENDEE, id);
export const revenueOf = (listingId: number): AccountRef => account(ACCT.REVENUE, listingId);
export const modifierAcct = (modifierId: number): AccountRef => account(ACCT.MODIFIER, modifierId);
```

### 6.2 Opaque references (`refs.ts`)

References must be **deterministic** (so a webhook replay regenerates the same
string and the unique index dedupes it) yet **non-reversible** (so a retained,
post-erasure ledger row leaks no provider identifier — §8). We reuse the app's
existing HMAC blind-index primitive (the same construction behind
`ticket_token_index`, `code_index`, `username_index`):

```ts
import { blindIndex } from "#shared/crypto/blind-index.ts"; // existing HMAC helper

/** "<group>:<hmac>" — group is a coarse, non-identifying label for leg-count
 *  checks (§4.9); the HMAC hides the underlying session/payment id. */
export const ledgerRef = async (group: string, ...parts: string[]): Promise<string> =>
  `${group}:${await blindIndex(parts.join("|"))}`;
```

So `ledgerRef("pay", paymentSessionId)` is stable across replays but reveals
nothing about the session id once stored.

### 6.3 The libsql adapter (`store.ts`)

Implements `LedgerStore` with narrow selects, and exposes `transferStatements`
(validate + build insert descriptors for the host's batch) and `postTransfers`
(its own batch, for admin/backfill). Omitted for brevity; identical statement
shapes to §4.7.

---

## 7. Mapping every money event to transfers

References are opaque HMACs (§6.2); amounts are minor units. Slot suffixes keep
multiple legs of one event idempotent independently.

### 7.1 Simple paid booking (with booking fee)

Attendee 88 pays for one £50 ticket on listing 45 with a £2 booking fee — £52
charged:

| source | destination | amount | kind | reference |
| --- | --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 5000 | `sale` | `sale:<hmac>:45` |
| `attendee:88` | `fee_income:booking` | 200 | `fee` | `fee:<hmac>` |
| `external:world` | `attendee:88` | 5200 | `payment` | `pay:<hmac>` |

- The **cash leg equals the full amount charged** (incl. fee). `balanceOf(attendee:88)`
  = 5200 − (5000 + 200) = 0 → settled. Without the fee leg the attendee would carry
  a phantom £2 credit and cash/revenue reports would disagree.
- Posted in the **same atomic batch** as attendee + `listing_attendees` creation
  *and the paid-booking finalize* (§9.2), so a crash or capacity failure rolls all
  of it back together.
- Multi-item orders post one `sale` leg per listing; one `fee` leg if a fee
  applies; one `payment` leg for the total charged.

### 7.2 Deposit + later balance settlement (guarded)

Full price £100 + £2 fee, 20% deposit now. At deposit:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 10000 | `sale` |
| `attendee:88` | `fee_income:booking` | 200 | `fee` |
| `external:world` | `attendee:88` | 2200 | `deposit` |

`balanceOf(attendee:88)` = 2200 − 10200 = −8000 → **owes £80, derived**.

**Settlement must keep a live guard.** The unique `reference` dedupes a *single*
session's replays, but two *different* balance-payment sessions opened for the
same attendee would otherwise both append `world→attendee` and over-credit them.
Today `settleAttendeeBalance` guards its batch on `remaining_balance =
expectedAmount` (`balance.ts:139-190`); we port that guard to the ledger via the
**`guardedInsertOnBalance`** descriptor (§4.7): the balance leg only posts while
`balanceOf(attendee:88)` still equals the expected pre-settlement value
(`−8000`). A second concurrent callback finds the balance already moved and
no-ops.

| source | destination | amount | kind | guard |
| --- | --- | --- | --- | --- |
| `external:world` | `attendee:88` | 8000 | `balance` | `balanceOf(attendee:88) == −8000` |

The history-destroying "fold into earliest line" update (`balance.ts:180-183`) is
gone; settlement is a single guarded append, and you can see both payments with
timestamps.

### 7.3 Refund — reverses the original legs (full or partial)

A refund **reverses the constituent legs of the original order**, not "everything
against revenue". This keeps every account correct when an order had a
fee/modifier. For a full refund of the £52 order in §7.1, reverse each leg:

| source | destination | amount | kind | reference |
| --- | --- | --- | --- | --- |
| `revenue:45` | `attendee:88` | 5000 | `refund_reversal` | `refundrev:<hmac>:45` |
| `fee_income:booking` | `attendee:88` | 200 | `refund_reversal` | `refundrev:<hmac>:fee` |
| `attendee:88` | `external:world` | 5200 | `refund_cash` | `refundcash:<hmac>` |

Afterwards `revenue:45`, `fee_income:booking`, `attendee:88`, and `world` are all
back to their pre-order values — no account is left stranded (the original bug
where revenue went negative while a modifier stayed positive).

- **Two distinct kinds** so reports don't double-count: the *reversal* legs
  (`refund_reversal`) un-recognise revenue/fee/modifier; the single *cash* leg
  (`refund_cash`) is the money returned. Refund totals sum **only `refund_cash`**
  (§11) — summing every `refund*` row would report ~2× the cash refunded.
- **Partial refunds** reverse a chosen subset/proportion of the original legs
  whose `refund_cash` sums to the refunded amount (the operator picks lines, or
  the system allocates proportionally). Multiple/repeat refunds are just more
  rows.
- **Provider side is NOT free.** Today `provider.refundPayment(ref): Promise<boolean>`
  takes **no amount** (`payments.ts:254-259`), so it can only refund the *whole*
  charge. Advertising partial refunds therefore requires an **amount-aware provider
  contract** — `refundPayment(ref, amount?)` plus amount-aware refund-status — which
  is a tracked prerequisite (§15). Until that lands, provider-issued refunds are
  full-only; partial refunds are limited to ledger-recorded cash/manual scenarios.

### 7.4 Modifier discount

List £50, −£5 promo (modifier 7):

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 5000 | `sale` |
| `modifier:7` | `attendee:88` | 500 | `discount` |
| `external:world` | `attendee:88` | 4500 | `payment` |

`balanceOf(modifier:7)` = −500 — exactly today's signed `total_revenue`. The
**direction (discount vs surcharge) is captured by which way the leg points**, and
that is stored immutably on the row — so going forward there's no sign ambiguity
(unlike `modifier_usages.amount_applied`, whose sign convention is implicit and
whose modifier may later be edited; see the backfill caveat in §12).

### 7.5 Surcharge / paid add-on

A +£3 surcharge/add-on (modifier 9) — the modifier *receives* money:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `modifier:9` | 300 | `surcharge` |

`balanceOf(modifier:9)` = +300. The buyer funds it through the `world→attendee`
payment leg sized to the net owed.

### 7.6 Pay-what-you-want / `can_pay_more`

No special handling: the `sale` leg is the amount the buyer chose (within the
validated `[expected, max_price]` range, `webhooks.ts` unchanged), and the
`payment` leg matches it.

### 7.7 Manual adjustment / comp / cash (admin)

Operator records a £40 cash payment, comps a ticket, or posts an opening balance:

| source | destination | amount | kind | posted_by |
| --- | --- | --- | --- | --- |
| `external:world` | `attendee:88` | 4000 | `manual` | `user:3` |

Always `posted_by` = the admin user, with a `memo`. See §10.

### 7.8 Provider fees & payouts (new capability — later phase)

Cash-in leg's source becomes the PSP instead of the world; fees/payouts drain the
PSP account:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `external:world` | `psp:stripe` | 5200 | `charge` |
| `psp:stripe` | `attendee:88` | 5200 | `payment` |
| `psp:stripe` | `fees:paid` | 90 | `fee_paid` |
| `psp:stripe` | `external:world` | 5110 | `payout` |

`balanceOf(psp:stripe)` reconciles against Stripe's reported balance (§4.9). Ship
the world-funds-attendee form first; this is additive, same table.

### 7.9 Summary

| Event | Transfer(s) | Replaces |
| --- | --- | --- |
| Booking (paid) | `attendee→revenue` + `attendee→fee_income`? + `world→attendee` | `price_paid` write + income trigger (and *adds* fee tracking) |
| Deposit | sale/fee legs + partial `world→attendee` | `remaining_balance` setup |
| Balance pay | **guarded** `world→attendee` | `settleAttendeeBalance` fold/guard |
| Refund (any amount) | reverse each original leg + one `refund_cash` | `refunded` flag |
| Discount / surcharge | `modifier→attendee` / `attendee→modifier` | `modifier_usages` money |
| Fee paid / payout | `psp→fees` / `psp→world` | *new* |
| Manual/comp/cash | any → any | activity-log free text |

---

## 8. Attendee deletion & data retention

**Requirement: deleting an attendee must not lose their financial record.**

### 8.1 Transfers are PII-free *and provider-identifier-free* by construction

A transfer row contains only: account `(type, id)` pairs, an integer amount, a
currency, timestamps, a `kind`, an **opaque HMAC `reference`**, and `posted_by`.
**No names, emails, phones, payment-intent ids, or checkout-session ids.**

- Provider references (Stripe `pi_…`, checkout session ids) are **never** placed
  in the plaintext `reference` — that would let a retained, post-erasure row be
  used to look the customer's payment up at the provider. References are HMAC blind
  indexes (§6.2); the recoverable provider id stays where it is today, in the
  **encrypted `pii_blob`**, and is therefore erased with the attendee.
- The library can't police `memo`; **house rule: `memo` is PII-free** (a code/short
  reason), encrypted by the host if it ever must hold sensitive text.

So retaining transfers after erasing an attendee is privacy-safe: amounts and
account ids, nothing that re-identifies the person or their payment.

### 8.2 Two distinct deletion semantics

1. **Order rollback** — a half-created order that never economically happened
   (capacity/stock lost the race; `consumeModifierStockOrRollback` →
   `deleteAttendee`, `modifier-usage.ts:100-108`). Post the order's transfers in
   the **same atomic batch** as attendee + `listing_attendees` + modifier-stock
   creation + the paid-booking finalize (§9.2); if the batch fails, nothing
   commits and there's nothing to clean up. Where stock consumption is a separate
   step, fold it in or have the rollback delete the just-written transfers **by
   reference group** (the order's HMAC).

2. **Erasure of a real, completed attendee** (operator delete; GDPR). The money
   moved, so **the financial record must survive**:

   > `deleteAttendee` (the generic erase path) MUST NOT delete that attendee's
   > transfers.

   The attendee row and PII go; the transfers stay, referencing a **dangling
   `attendee:<id>`** tombstone. Reporting renders "deleted attendee #<id>".

   Note: today `deleteAttendee` recomputes `listings.income` from `SUM(price_paid)`
   at delete time (`delete.ts:23`). That mechanism is removed — income is
   ledger-derived and erasing the attendee deliberately leaves the revenue
   transfers in place, so income is unaffected by erasure.

### 8.3 The no-FK convention helps

No `ON DELETE CASCADE` from `attendees` can take the ledger with it. Failed-order
cleanup is an explicit, reference-scoped delete; the erase path never touches
`transfers`.

### 8.4 Derived balances after erasure

Outstanding balance is a **live** concept for existing attendees
(`−balanceOf(attendee:A)`). An erased attendee has none — correct. Revenue/refund
reports aggregate by `revenue:<listing>`/kind/time, unaffected by erasure.

---

## 9. Idempotency & concurrency

### 9.1 Reference = opaque idempotency key

Every transfer carries an opaque, deterministic HMAC `reference` (§6.2) with a
`UNIQUE` index; inserts `ON CONFLICT(reference) DO NOTHING`. A replay regenerates
the same HMAC and no-ops. Each leg gets its own stable group + slot:
`sale:<hmac>:<listingId>`, `fee:<hmac>`, `pay:<hmac>`, `bal:<hmac>`,
`refundrev:<hmac>:<slot>`, `refundcash:<hmac>`, `mod:<hmac>:<modifierId>`,
`manual:<uuid>`. The `group` prefix also feeds the leg-count reconciliation (§4.9).

### 9.2 Same-batch atomicity — including a *paid-booking* finalize (new prerequisite)

Transfer inserts must share the **same `executeBatchWithResults` batch** as the
attendee creation **and** the `processed_payments` finalize, so a crash can't
leave posted transfers behind an unresolved reservation (which, after the stale
lock releases, could let a retry create a *second* attendee while the orphaned
ledger rows linger).

Important accuracy point uncovered in review: on the **paid** path,
`processReservedSession` creates the attendee and then calls `finalizeSession` as
a **separate `UPDATE`** — it is *not* currently folded into the creation batch.
(The *balance* path already does the right thing via `balanceFinalizeStatement`,
`balance.ts:148-151`.) So Phase 1 has a **prerequisite refactor**: introduce a
`paidBookingFinalizeStatement` (mirroring `balanceFinalizeStatement`) and run
creation + finalize + transfer inserts in one atomic batch. Only then does the
"posted exactly once" guarantee hold. This is called out in §12 and §16.

### 9.3 Settlement & no-new-locking

Booking/refund legs are dedupe-by-reference. The one place a unique reference is
insufficient — two *different* sessions settling the same outstanding balance — is
handled by the `guardedInsertOnBalance` compare-and-post (§7.2). No in-place
balance mutation means no other write contention.

---

## 10. Admin view & adjusting the historical record

### 10.1 Append-only; corrections are first-class

Posted transfers are **immutable**. "Adjusting" appends new rows. Three operator
actions, all `posted_by = user:<id>` + required `memo`:

1. **Void / reverse** → `reverseOf(t)` (§4.6). **Guarded to once** by the unique
   `reverses_id` index (§5), so a double-click can't over-reverse.
2. **Correct** → `reverseOf(old)` + a new corrected transfer, one batch, linked by
   `reverses_id`.
3. **Manual post** → arbitrary `source → destination` (cash, comp, opening
   balance, write-off).

Each adjustment is a normal row, appears in reports and the audit chain, and also
logs a human line to `activity_log` (as refunds/balance payments do today).

### 10.2 Pages

- **`/admin/accounting`** — ledger browser (filter by account / date / kind;
  period totals).
- **Account statement** — `statementFor(account)` with running balance.
- **Per-attendee money panel** — replaces `attendee-balance.tsx`: the attendee's
  legs + derived outstanding; read-only and still resolves for a tombstone.
- **Reconciliation** — uses the **non-tautological** checks (§4.9):
  `reconcileExternal` (PSP vs provider balance) and `expectLegCounts` (per-event
  leg sanity), **not** `Σ balance == 0` alone. Plus the migration parity oracle.
- **Reports** — §11.

### 10.3 On destructive edits

Row mutation/delete is intentionally not in the normal UI. A genuine hard edit
(e.g. legal scrub of a mis-entered memo) is superuser-gated, logs before/after to
`activity_log`, and re-runs reconciliation. Corrections (10.1) are the default.

---

## 11. Reporting unlocked

Each is a narrow SQL fetch feeding a pure projection.

- **Net revenue over a period:** `inPeriod(from,to)` over `revenue:*`, `modifier:*`,
  `fee_income:*`; sum `allBalances` → gross, modifier effect, fee, net — by
  month/day.
- **Refunds in a period:** `sumOfKind("refund_cash", {from,to})` — **cash leg only**,
  so a £20 refund counts as £20 (not £40).
- **Per-listing P&L:** `balanceOf(revenueOf(L))` (gross) + attributed modifiers/fees.
- **Outstanding balances:** per live attendee `−balanceOf(attendeeAcct(A))`; total.
- **Cash vs recognised revenue:** `world→*` legs vs `*→revenue` legs — the gap is
  outstanding receivables.
- **Provider reconciliation:** `reconcileExternal(psp(p), reported)`.
- **Modifier revenue:** `balanceOf(modifierAcct(M))` — replaces `total_revenue`.

The headline — **"take in / refund / net between X and Y?"** — goes from impossible
to a one-liner. A flat "general journal" CSV over a range hands off to real
accounting software.

---

## 12. Migration plan

Incremental, dual-write — the app works at every step.

### Phase 0 — Library + table, zero behaviour change

- Build `src/shared/ledger/` (pure) with full unit/property tests. Shippable alone.
- Add the `transfers` table to `SCHEMA` (incl. the unique `reverses_id` index).
- Build `src/shared/accounting/` (chart, refs, store, mappers), not yet called.

### Phase 1 — Prereq refactor, then dual-write + backfill

- **Prerequisite (§9.2):** add `paidBookingFinalizeStatement` and move the paid
  path's `finalizeSession` into the attendee-creation batch, so transfers can join
  one atomic, finalize-guarded batch. **Without this, do not wire ledger writes.**
- Dual-write transfers in the batches for booking creation, balance settlement
  (using the guarded insert), refunds (reversal + cash legs), and modifier
  consumption. Old columns remain source of truth; transfers are shadow.
- **Backfill** (best-effort), with honest caveats:
  - bookings → `attendee→revenue` (gross) + `fee_income` (if recoverable) +
    `world→attendee` (from `price_paid`).
  - modifiers → from `modifier_usages`; **direction is reconstructed from the
    modifier's current `direction`/calc config**, which may be wrong if the
    modifier was later edited or its row deleted. Old discount/surcharge
    classification is therefore explicitly best-effort; going forward the leg
    direction is stored immutably (§7.4). Where direction is unrecoverable, post a
    flagged adjustment for manual review rather than guess.
  - refunds → from `refunded` flags (amount from `price_paid`; **date unknown**,
    `occurred_at` = backfill time).
  - deposits → one `world→attendee` payment leg; the **deposit/balance split and
    dates are unrecoverable** (already folded).
  - State plainly: pre-cutover history is *summarised*, not itemised.
- **Parity oracle (refund-aware).** `listings.income` is `SUM(price_paid)` and
  *still counts refunded rows* (`schema.ts:819-821`), i.e. it is **gross**. So the
  oracle must compare it against the **gross sale legs** (`sumOfKind("sale")` into
  `revenue:L`, *before* refund reversals), **not** the net `balanceOf(revenue:L)`.
  Separately check refunds (`refund_cash` sum) and outstanding
  (`−balanceOf(attendee)` vs `remaining_balance`). Run until green on real data.

### Phase 2 — Migrate reads

- Switch income, outstanding, amount-paid, refund status, and modifier revenue to
  the ledger. Add period reports (§11) and admin pages (§10). Old columns become a
  parity oracle only.

### Phase 3 — Retire (the all-in cut)

- Delete every redundant money column and trigger (§14). Replace the
  `settleAttendeeBalance` fold with the guarded append. Demote `modifier_usages`
  to a pure stock ledger (drop `amount_applied`).

Each phase is a normal PR passing `deno task precommit` on its own.

---

## 13. Testing strategy

### Pure library (the bulk)

- **Table-driven** validation (every `LedgerError`, boundaries).
- **Property/metamorphic:** `balanceOf == Σ in − Σ out`; `reverseOf` nets to zero;
  buckets partition; order-independence; **mixed-currency input throws**
  (`assertSingleCurrency`); `sumOfKind("refund_cash")` counts a £20 refund once.
- 100% coverage falls out (pure, total functions).

### Integration (small, high-value) — `#test-utils` + real test DB

- **No double-credit on replay:** same session twice ⇒ one set of legs.
- **Paid-path atomicity:** crash between creation and finalize ⇒ *no* orphaned
  transfers (validates the §9.2 refactor); retry creates exactly one attendee.
- **Booking fee:** £50+£2 ⇒ `balanceOf(attendee)==0`, fee income == £2.
- **Guarded settlement:** two concurrent balance sessions for one attendee ⇒ the
  balance is credited **once**; the second no-ops.
- **Refund correctness:** full refund of a fee+surcharge order leaves revenue, fee,
  and modifier accounts all back to zero; partial refunds sum on `refund_cash`;
  refund exceeding paid is rejected.
- **Reverse-once:** double-clicked void ⇒ second insert rejected by unique
  `reverses_id`.
- **Erasure retains transfers:** delete a paid attendee ⇒ transfers remain, no PII
  or provider id in any retained row, income unchanged.
- **Backfill parity:** gross sale legs == `listings.income`; ledger outstanding ==
  `remaining_balance`.

### Determinism

`occurredAt`/`recordedAt`/references injected (`nowIso`, HMAC) — no flakiness;
every branch gets a direct in-process test (per `AGENTS.md`).

---

## 14. What this retires — the definitive removal list

We are **all-in**: Phase 3 deletes the following. Each names the readers to move to
a ledger-derived value first. **No money column survives.**

| Removed | Type | Becomes | Readers to migrate first |
| --- | --- | --- | --- |
| `listing_attendees.price_paid` | money | `world→attendee` cash legs; per-line = `attendee→revenue` | `balance.ts` order summary; `queries.ts` `ATTENDEE_COLS`/detail/list; `atomic-update.ts`; `capacity.ts` insert; `delete.ts:23` income recompute; `attendee-merge.ts`; confirmation email; scanner; attendees CSV; `webhooks.ts` create |
| `attendees.remaining_balance` | money | `−balanceOf(attendee:A)` | `balance.ts`; `attendee-balance.ts`; public `balance.ts`; webhooks |
| `attendees.price_paid` (TEXT, in `pii_blob`) | money snapshot | sum of attendee cash legs (derive for the email) | `pii.ts:98`; `create.ts:106`; confirmation templates |
| `listing_attendees.refunded` | money flag | refund legs exist / their `refund_cash` sum (**partial refunds**) | `queries.ts`; `atomic-update.ts`; scanner; attendee detail badge; refund guard in `attendee-refunds.ts` |
| `listings.income` + income leg of `LISTING_AGGREGATE_TRIGGERS` | money | `balanceOf(revenueOf(L))` | `stats.ts`; dashboard; listings CSV; `listings.ts` cache load |
| `modifiers.total_revenue` | money | `balanceOf(modifierAcct(M))` | `modifiers.ts` recalculation; modifiers admin page |
| `modifiers.total_uses`, `usage_count` + `MODIFIER_AGGREGATE_TRIGGERS` | counts | live `COUNT(*)`/`SUM(quantity)` over the retained stock ledger | modifiers admin page; recalculation |
| `modifier_usages.amount_applied` | money | `modifier:M` transfers | `modifier-usage.ts`; webhooks consume |
| `settleAttendeeBalance` fold UPDATE (`balance.ts:180-183`) | money mutation | guarded `world→attendee` append | — |
| money lines in `activity_log` (free text) | money log | structured transfers (+ a human summary line stays) | refund/balance log sites |

### Explicitly **kept** (not money)

- `listing_attendees.quantity`, `listings.booked_quantity`/`tickets_count` and the
  **capacity** part of `LISTING_AGGREGATE_TRIGGERS` (rewritten to drop only the
  income leg; `LISTING_AGGREGATE_WRITE_COLUMNS` drops `price_paid`).
- `modifier_usages` rows (`modifier_id, attendee_id, quantity, created`) — the
  **stock ledger**; live stock check (`modifier-usage.ts:26-36`) untouched.
- `listings.unit_price`, `day_prices`, `max_price`, `can_pay_more`,
  `attendee_statuses.reservation_amount` — **pricing configuration**, not records of
  money that moved.

---

## 15. Decisions (resolved)

1. **All-in, no parallel money state** (§14). Any future cache is ledger-rebuilt
   with a recalculation endpoint, never a second source of truth.
2. **Recognition at sale, gross**; modifiers and the booking fee adjust via their
   own accounts (§3, §7). Deferred-to-event-date accrual (`deposits:held`
   liability) is a later opt-in; the `DEPOSITS` type is reserved.
3. **Booking fee is income**, recorded as its own `fee_income:booking` leg so the
   cash leg always equals the amount charged (no phantom attendee credit).
4. **Single currency, enforced in code** — the projections throw on a mixed-currency
   slice (`assertSingleCurrency`, §4.5), not just by convention.
5. **Balance settlement keeps a live guard** ported to the ledger
   (`guardedInsertOnBalance`, §7.2) — a plain append would over-credit.
6. **References are opaque HMACs**, never provider ids (§6.2/§8); provider ids stay
   in the encrypted `pii_blob` and are erased with the attendee.
7. **Paid-path finalize must be batched** with creation + ledger inserts; this is a
   Phase-1 prerequisite refactor (§9.2), since the paid path currently finalizes
   separately.
8. **Refunds reverse the original legs** (revenue/fee/modifier) + one `refund_cash`
   leg; reports sum `refund_cash` only (§7.3, §11).
9. **Partial refunds need an amount-aware provider contract** —
   `refundPayment(ref, amount?)` + amount-aware status. Until shipped, provider
   refunds are full-only; ledger partials are for cash/manual. Tracked as a
   dependency, not assumed free.
10. **At most one reversal per original**, enforced by the unique `reverses_id`
    index (§5), so a double-click can't over-reverse.
11. **`modifier_usages` stays as a stock ledger**, money stripped out (§14).
12. **`Σ balance == 0` is a sanity check only**; reconciliation uses provider
    balances and per-event leg counts (§4.9, §10.2).
13. **Corrections-only** adjustments; destructive hard-edit is a guarded superuser
    exception (§10.3).

---

## 16. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Paid-path finalize not batched ⇒ orphaned transfers / double attendee | High | Phase-1 prerequisite refactor (`paidBookingFinalizeStatement`, §9.2); crash-between test (§13). |
| Over-credit from concurrent balance sessions | High | `guardedInsertOnBalance` compare-and-post (§7.2); concurrent-settlement test. |
| Provider ids retained in plaintext after erasure | High (privacy) | HMAC references (§6.2); provider ids only in encrypted `pii_blob`; retention test asserts no provider id in a retained row. |
| Booking fee unaccounted ⇒ cash/revenue disagree | High | Explicit `fee_income` leg; cash leg == amount charged; booking-fee test. |
| Double-credit on webhook replay | High | Same-batch finalize + `UNIQUE(reference)` + `ON CONFLICT DO NOTHING`; replay test. |
| Refund double-count / stranded accounts | Medium | Reverse original legs; `refund_cash`-only totals; refund-correctness test. |
| Partial refund unsupported at provider | Medium | Amount-aware contract as an explicit dependency (§15.9); full-only until then. |
| Reverse-twice over-reversal | Medium | Unique `reverses_id` index; double-void test. |
| Mixed-currency silent sums | Medium | `assertSingleCurrency` in projections; currency-scoped queries; throw test. |
| Parity oracle false mismatch on refunded rows | Medium | Compare gross sale legs to gross `listings.income`, refund-aware oracle (§12). |
| Modifier backfill misclassifies old direction | Medium (accepted) | Best-effort from config; flag unrecoverable for manual review; immutable direction forward. |
| Removing `price_paid`/`refunded` touches many readers | Medium (wide) | Phased dual-write; migrate each reader (enumerated §14) before dropping. |
| Income semantics shift (cash-paid → recognised) | Medium | Documented (§3); parity oracle makes it visible during migration. |
| Money/capacity entanglement | High | Ledger is money-only; seats stay on `listing_attendees`, stock in `modifier_usages`; capacity triggers kept, income leg dropped. |
| Backfill loses deposit/refund detail | Certain (accepted) | Best-effort opening transfers; documented summary-not-itemised. |
| Cascade deletes a tombstoned attendee's transfers | High | No FKs/cascade; erase path never touches `transfers`; rollback deletes only by reference group; erasure-retention test. |
| `Σ balance == 0` mistaken for reconciliation | Medium | Documented as tautological (§3/§4.9); real checks added. |
| Derived `SUM` too slow at scale | Low/Med | Narrow indexed queries; ledger-rebuilt cache + recalculation if profiling demands. |

---

## 17. Review findings folded in

The first adversarial review (Codex) raised 12 points; all were valid and are now
reflected above:

- **P1 — booking fee** unaccounted → `fee_income` leg, cash leg == charged (§7.1, §15.3).
- **P1 — provider ids in references** break erasure → HMAC references (§6.2, §8.1).
- **P1 — paid-path finalize not batched** → Phase-1 prerequisite refactor (§9.2).
- **P1 — balance settlement loses its guard** → `guardedInsertOnBalance` (§7.2).
- **P2 — refund double-count** → distinct `refund_cash`/`refund_reversal` kinds (§7.3, §11).
- **P2 — refund strands modifier/fee accounts** → reverse the original legs (§7.3).
- **P2 — partial refund vs amountless provider API** → amount-aware contract dependency (§15.9).
- **P2 — mixed-currency sums** → enforced `assertSingleCurrency` (§4.5).
- **P2 — reverse-twice** → unique `reverses_id` (§5, §10.1).
- **P2 — parity oracle vs refunded income** → compare gross sale legs (§12).
- **P2 — modifier backfill direction** → best-effort + immutable-forward (§7.4, §12).
- **P2 — tautological conservation check** → reconcile against source records (§4.9, §10.2).

---

### One-paragraph summary

Introduce a single append-only `transfers` table — money moving from a typed
source account to a typed destination account, positive amounts, hardcoded ids for
singletons like the outside world, each PSP, and the booking-fee income bucket.
Promote the attendee to a first-class account (a receivable) so "paid" and "owed"
are derived, not stored. Front it with a small, pure, context-free library
(`src/shared/ledger/`) doing validation, currency-guarded balance/period
projection, non-tautological reconciliation, reversals, and statement-descriptor
construction (including a guarded compare-and-post for balance settlement), driven
through a thin host glue (`src/shared/accounting/`) holding the chart of accounts,
opaque HMAC references, and event mappers. We go all-in: income, outstanding
balance, amount-paid, refunds, and modifier revenue all become `SUM` over the
ledger, and every redundant money column and its triggers are deleted (§14).
Transfers are PII- and provider-id-free and never cascade-deleted, so an
attendee's financial record survives their erasure. An admin view inspects the
ledger and adjusts history only by appending corrections (reverse-once enforced).
Ship it incrementally — but the load-bearing prerequisite is batching the
paid-booking finalize with the ledger insert on the payment path, or a replay can
double-credit.
