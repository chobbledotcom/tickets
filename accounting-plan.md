# Double-Entry Accounting — Design Doc

A plan to replace the platform's scattered, mutable money state with a single
append-only **transfer ledger**, fronted by a small, pure, context-free
accounting library that the rest of the system hooks into.

We go **all-in**: the ledger becomes the single source of truth for 100% of
accounting. Every column that records money is removed once its reads are
migrated — no parallel money state, no "cache that's also a source of truth".

Status: **proposal**. Nothing here is built yet. This doc is the thing to argue
with before any code is written.

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
  and survive.
- **An admin view** to inspect the ledger and adjust the historical record —
  safely, by appending corrections, never by destructive edits.

### Non-goals (for the first version)

- A user-editable chart of accounts. The chart is a small set of code constants.
- Tax computation. (Tax, if ever needed, is just another account.)
- Multi-currency *operation*. The `currency` column exists from day one, but the
  app stays single-currency per site and the library refuses mixed-currency
  arithmetic.
- Automated provider-fee/payout import. The model *supports* fees and payouts
  (§7.7); wiring real Stripe/Square fee data in is a later phase that adds no new
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
the deposit/balance history is overwritten on settlement.

Two things make this a *low-novelty* change rather than a leap:

1. **The pattern already exists in-house, twice.** `modifier_usages` is an
   append-only ledger with guarded atomic inserts (`modifier-usage.ts:38-85`),
   trigger-maintained cached aggregates, *and* a recalculation/audit endpoint
   (`features/admin/aggregate-recalculation.ts`). The transfer ledger is that
   exact pattern, generalised to all money.
2. **Amounts are already plaintext integer minor units** (`currency.ts`), and
   `attendee_id` / `listing_id` are already plaintext FKs. So a ledger of
   amounts keyed by those ids introduces **no new encryption design**.

This also lands squarely on three house principles from `AGENTS.md`:

- **"Schema over organic structure / make invalid arrangements
  unrepresentable."** A single source→destination row *cannot* be unbalanced.
- **"Trust application invariants… if an impossible state is observed, raise an
  error."** The ledger has a global conservation invariant (§3) you can assert.
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
**singletons** with hardcoded ids (the outside world, each payment processor). No
`accounts` table is required: an account "exists" exactly when a transfer
references it. (A tiny optional metadata map gives singletons display names — §6.)

### The attendee is an account (this is what lets us delete `price_paid` and `remaining_balance`)

The key modelling move that makes "all-in" possible: **each attendee is a real
account — a receivable / clearing account.** A sale *bills* the attendee; cash
*funds* the attendee. The attendee account's balance is, by construction, exactly
what they still owe (or are owed). This is why we can derive both "amount paid"
and "outstanding balance" from the ledger alone and delete the columns that store
them today.

- **Bill the attendee for the sale** (revenue recognised): `attendee:A → revenue:L`
- **Fund the attendee with cash**: `world → attendee:A`
- **Outstanding(A) = −balanceOf(attendee:A)** — negative balance means they owe,
  positive means they have credit (overpaid). Fully paid ⇒ balance 0.

### Balances are derived

For any account `A`:

```
balance(A) = SUM(amount where dest = A) − SUM(amount where source = A)
```

### The conservation invariant (free self-check)

We always model the outside world as a real account (`external:world`). So across
*every* account in the system:

```
Σ balance(A)  ==  0      for all accounts A
```

This holds by construction (each row adds `+amount` to one account and `−amount`
to another) and is the thing the test suite and the admin reconciliation page
assert. A non-zero global sum means corruption — an "impossible state" we raise
on, per house rules.

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
**recognised net revenue** = `Σ balanceOf(revenue:*) + Σ balanceOf(modifier:*)`,
which equals cash received once everything is settled and correctly *includes*
billed-but-unpaid balances before then. This is a deliberate, documented shift
from today's pure cash-paid number — and a strictly more useful one. (A full
accrual variant that defers recognition to the event date is a later option, §15.)

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
  reverse.ts      # pure construction of reversing/adjusting transfers
  statements.ts   # pure: TransferInput -> { sql, args } statement descriptor
  invariants.ts   # pure: assertConserved, assertSingleCurrency, etc.
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

/** The data needed to post one transfer. `occurredAt` and `reference` are
 *  supplied by the caller — the library performs no I/O and reads no clock. */
export type TransferInput = {
  readonly source: AccountRef;
  readonly destination: AccountRef;
  readonly amount: MinorUnits;
  readonly currency: string; // ISO-4217, opaque to the library
  readonly occurredAt: string; // ISO timestamp — business time of the event
  /** Idempotency key. Posting the same reference twice is a no-op (§9). */
  readonly reference: string;
  /** Host-defined category label, opaque to the library (e.g. "refund"). */
  readonly kind?: string;
  /** Free-text reason. MUST be PII-free (see §8) — the library cannot enforce
   *  this, so the host is responsible. */
  readonly memo?: string;
  /** id of the transfer this one reverses/corrects, for the audit chain. */
  readonly reversesId?: number;
  /** Actor: "system" or an admin user id. Opaque. */
  readonly postedBy?: string;
};

/** A persisted transfer: an input plus the assigned surrogate id and record
 *  time. This is the shape projections operate on. */
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

/** Stable canonical key for use as a Map key / dedupe / grouping. */
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

These take an array of `Transfer` and compute everything. Total, deterministic,
side-effect-free — ideal for table-driven and property tests.

```ts
import { filter, reduce, sumOf } from "#fp";
import { accountKey, sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

/** Net balance of a single account: money in minus money out. */
export const balanceOf =
  (acct: AccountRef) =>
  (transfers: Transfer[]): number => {
    const into = sumOf((t: Transfer) =>
      sameAccount(t.destination, acct) ? t.amount : 0,
    )(transfers);
    const outOf = sumOf((t: Transfer) =>
      sameAccount(t.source, acct) ? t.amount : 0,
    )(transfers);
    return into - outOf;
  };

/** Every account's balance, keyed by canonical account key. */
export const allBalances = (transfers: Transfer[]): Map<string, number> =>
  reduce((acc: Map<string, number>, t: Transfer) => {
    acc.set(accountKey(t.destination), (acc.get(accountKey(t.destination)) ?? 0) + t.amount);
    acc.set(accountKey(t.source), (acc.get(accountKey(t.source)) ?? 0) - t.amount);
    return acc;
  }, new Map<string, number>())(transfers);

/** Filter to a half-open business-time window [from, to). */
export const inPeriod =
  (from: string, to: string) =>
  (transfers: Transfer[]): Transfer[] =>
    filter((t: Transfer) => t.occurredAt >= from && t.occurredAt < to)(transfers);

/** A running-balance statement for one account (for the admin statement view). */
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

`allBalances`, `balanceOf`, `statementFor`, `inPeriod` plus a small
`bucketByMonth`/`bucketByDay` are the entire reporting engine. Reports (§11) are
these pure functions applied to a SQL-narrowed slice of rows.

### 4.6 Reversals & adjustments (`reverse.ts`) — pure

The only correct way to "edit" a posted transfer is to post its inverse (and, for
a correction, a fresh corrected transfer). The library builds the inverse:

```ts
import type { Transfer, TransferInput } from "./types.ts";

/** Build the transfer that exactly undoes `t`: same amount, swapped ends. The
 *  caller supplies the new occurredAt/reference/actor so the library stays pure. */
export const reverseOf = (
  t: Transfer,
  meta: { occurredAt: string; reference: string; postedBy: string; memo?: string },
): TransferInput => ({
  amount: t.amount,
  currency: t.currency,
  destination: t.source, // swapped
  kind: "reversal",
  memo: meta.memo ?? "",
  occurredAt: meta.occurredAt,
  postedBy: meta.postedBy,
  reference: meta.reference,
  reversesId: t.id,
  source: t.destination, // swapped
});
```

A *correction* is `reverseOf(old)` plus a new corrected `TransferInput`, posted
together in one batch (§10).

### 4.7 Statement descriptors (`statements.ts`) — pure, the batching linchpin

The library does **not** open transactions or call the DB. It turns a validated
`TransferInput` into a `{ sql, args }` descriptor — exactly the shape `balance.ts`
and `modifier-usage.ts` already pass to `executeBatchWithResults`. The host drops
these into *its own* atomic batch (e.g. alongside the `processed_payments`
finalize), which is what makes hot-path atomicity and idempotency possible without
the library knowing anything about payments.

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
```

### 4.8 The persistence port (`ports.ts`) — interface only

```ts
import type { AccountRef, Transfer } from "./types.ts";

export type DateRange = { from?: string; to?: string };

/** Implemented by the host against libsql. The library defines it; it never
 *  implements it. Queries are intentionally narrow (account- or period-scoped),
 *  so the pure projections run over bounded row sets, not the whole table. */
export interface LedgerStore {
  byAccount(account: AccountRef, range?: DateRange): Promise<Transfer[]>;
  byReference(reference: string): Promise<Transfer | null>;
  byKind(kind: string, range?: DateRange): Promise<Transfer[]>;
  inPeriod(range: DateRange): Promise<Transfer[]>;
}
```

### 4.9 Invariants (`invariants.ts`) — pure

```ts
import { allBalances } from "./project.ts";
import type { Transfer } from "./types.ts";

/** True iff every account balance sums to zero across the system. */
export const isConserved = (transfers: Transfer[]): boolean => {
  let total = 0;
  for (const b of allBalances(transfers).values()) total += b;
  return total === 0;
};
```

---

## 5. Persistence: the `transfers` table

Added to the declarative schema in `src/shared/db/migrations/schema.ts` (the
`SCHEMA` array), so the existing migration/`SCHEMA_HASH` machinery picks it up.
Mirrors the column shape from the model: source/destination as `(type, id)`,
amount, currency, timestamp — plus idempotency, audit, and reversal columns.

```ts
[
  "transfers",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      // Idempotency key. Replays collide here and ON CONFLICT no-ops them.
      ["reference", "TEXT NOT NULL"],
      ["source_type", "TEXT NOT NULL"],
      ["source_id", "TEXT NOT NULL"],
      ["dest_type", "TEXT NOT NULL"],
      ["dest_id", "TEXT NOT NULL"],
      // Positive minor units; direction is encoded by source/dest, never sign.
      ["amount", "INTEGER NOT NULL CHECK (amount > 0)"],
      ["currency", "TEXT NOT NULL"],
      // Business time (when the money moved) vs record time (when we wrote it).
      // They differ for backdated adjustments and backfilled history.
      ["occurred_at", "TEXT NOT NULL"],
      ["recorded_at", "TEXT NOT NULL"],
      ["kind", "TEXT NOT NULL DEFAULT ''"],
      ["memo", "TEXT NOT NULL DEFAULT ''"],
      // The transfer this one reverses/corrects (app-enforced, no FK — matches
      // the project's no-FK convention for recreate-friendly migrations).
      ["reverses_id", "INTEGER"],
      ["posted_by", "TEXT NOT NULL DEFAULT 'system'"],
    ],
    indexes: [
      { columns: ["reference"], name: "idx_transfers_reference", unique: true },
      { columns: ["source_type", "source_id"], name: "idx_transfers_source" },
      { columns: ["dest_type", "dest_id"], name: "idx_transfers_dest" },
      { columns: ["occurred_at"], name: "idx_transfers_occurred_at" },
      { columns: ["kind"], name: "idx_transfers_kind" },
    ],
  },
],
```

Design notes:

- **`id` is TEXT for accounts.** The library treats account ids as opaque
  strings; the host stores stringified integers for row-backed accounts and fixed
  strings (`"world"`, `"stripe"`) for singletons. Keeps the table generic and the
  library context-free.
- **No FKs**, per the project's stated convention (`schema.ts:323-325`,
  `359-362`). Referential rules are application-enforced — and §8 explains why we
  *want* the absence of a cascade from `attendees`.
- **No money triggers.** Balances are derived. (Capacity triggers on
  `listing_attendees` stay — they're not money; see §14.) If a hot read ever
  needs caching, we add a cached aggregate + recalculation endpoint **rebuilt from
  the ledger**, never a second source of truth.
- `recorded_at` is supplied via `nowIso()` from `#shared/now.ts` at the call site
  (mockable in tests), never read inside the library.

---

## 6. The host glue (`src/shared/accounting/`) — chart of accounts & event mappers

This is where *context* lives. It depends on both the generic library and the
app. The library never depends on it.

```
src/shared/accounting/
  accounts.ts   # the chart of accounts: types + singleton ids + ref builders
  store.ts      # libsql adapter implementing LedgerStore + batch helpers
  events.ts     # map domain events (booking/refund/balance/modifier) -> drafts
  report.ts     # report queries (narrow SQL) feeding the pure projections
  display.ts    # singleton display names, account labels for the admin UI
```

### 6.1 The chart of accounts (`accounts.ts`)

```ts
import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";

/** Account *types*. A small, closed set — the only "schema" of meaning. */
export const ACCT = {
  ATTENDEE: "attendee", // row-backed: id = attendees.id — the receivable
  DEPOSITS: "deposits", // singleton liability: deposits held (optional, §15)
  EXTERNAL: "external", // singleton: the outside world (cards, bank)
  FEES: "fees", // singleton expense: provider/booking fees (later phase)
  MODIFIER: "modifier", // row-backed: id = modifiers.id — discount/surcharge effect
  PSP: "psp", // singleton-ish: id = "stripe" | "square" | "sumup" (later phase)
  REVENUE: "revenue", // row-backed: id = listings.id — gross sales
} as const;

// ── Hardcoded singletons (the "our Stripe account" pattern) ───────────────
export const WORLD: AccountRef = account(ACCT.EXTERNAL, "world");
export const DEPOSITS_HELD: AccountRef = account(ACCT.DEPOSITS, "held");
export const FEES_PAID: AccountRef = account(ACCT.FEES, "paid");
export const psp = (provider: "stripe" | "square" | "sumup"): AccountRef =>
  account(ACCT.PSP, provider);

// ── Row-backed account builders ───────────────────────────────────────────
export const attendeeAcct = (attendeeId: number): AccountRef => account(ACCT.ATTENDEE, attendeeId);
export const revenueOf = (listingId: number): AccountRef => account(ACCT.REVENUE, listingId);
export const modifierAcct = (modifierId: number): AccountRef => account(ACCT.MODIFIER, modifierId);
```

### 6.2 The libsql adapter (`store.ts`)

Implements `LedgerStore` with narrow selects (per "select only needed columns"),
and exposes a `transferStatements(drafts)` that validates (pure) and returns the
insert descriptors so callers on the payment hot path can fold them into *their*
batch — plus a `postTransfers(drafts)` convenience that runs its own batch for
non-hot-path callers (admin adjustments, backfill).

```ts
import { nowIso } from "#shared/now.ts";
import { insertTransferStatement } from "#shared/ledger/statements.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";
import type { TransferInput } from "#shared/ledger/types.ts";

/** Validate every draft, return insert descriptors. Throws on an invalid draft
 *  (a programming error — drafts come from trusted mappers). */
export const transferStatements = (drafts: TransferInput[]) => {
  const at = nowIso();
  return drafts.map((d) => {
    const r = validateTransfer(d);
    if (!r.ok) throw new Error(`invalid transfer: ${JSON.stringify(r.errors)}`);
    return insertTransferStatement(d, at);
  });
};
```

The row→`Transfer` mapper and the `byAccount` / `inPeriod` queries are standard
narrow selects; omitted here for brevity.

---

## 7. Mapping every money event to transfers

Each event posts one or more transfers. References are deterministic so a webhook
replay regenerates identical strings and the inserts no-op (§9). All amounts are
minor units.

### 7.1 Simple paid booking

Attendee 88 pays £50 for one ticket on listing 45, in full:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 5000 | `sale` |
| `external:world` | `attendee:88` | 5000 | `payment` |

- `balanceOf(attendee:88)` = 0 → settled. `balanceOf(revenue:45)` = 5000.
- Posted in the **same atomic batch** as attendee + `listing_attendees` creation
  (`create.ts:232-235`), so capacity failure rolls the transfers back too.
- A multi-item order posts one `sale` leg per listing and one `payment` leg per
  amount actually charged, sharing a session reference with per-leg slot suffixes.

> Why two rows for a simple booking? Because the attendee is an account, the same
> shape covers deposits, partial payments, refunds, and "what did this attendee
> pay / still owe" without any extra columns. Uniformity beats saving a row.

### 7.2 Deposit + later balance settlement

Full price £100, 20% deposit now, £80 later. At deposit:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 10000 | `sale` |
| `external:world` | `attendee:88` | 2000 | `deposit` |

`balanceOf(attendee:88)` = 2000 − 10000 = −8000 → **owes £80, derived** (no
`remaining_balance` column). At balance settlement:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `external:world` | `attendee:88` | 8000 | `balance` |

Now `balanceOf(attendee:88)` = 0 → settled. You can *see* the £20 on day 1 and the
£80 on day 30 with timestamps. The history-destroying "fold into earliest line"
update (`balance.ts:180-183`) is gone — settlement is just an append.

### 7.3 Refund (full or partial — newly possible)

Refund £20 of attendee 88's booking on listing 45:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `revenue:45` | `attendee:88` | 2000 | `refund` |
| `attendee:88` | `external:world` | 2000 | `refund` |

- The first leg un-recognises £20 of revenue; the second returns £20 of cash.
  `balanceOf(attendee:88)` is unchanged (still settled); `revenue:45` drops by £20.
- **Partial and repeat refunds just work** (post more). Net income reflects them
  automatically. Replaces the boolean `refunded` flag; "is/how-much refunded" is a
  derived query over `refund` legs.
- The provider API refund call (`provider.refundPayment`, `attendee-refunds.ts`)
  is unchanged; we additionally record the movement. Reference `refund:{paymentRef}:{seq}`.

### 7.4 Modifier discount

List price £50, a −£5 promo discount (modifier 7):

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `revenue:45` | 5000 | `sale` |
| `modifier:7` | `attendee:88` | 500 | `discount` |
| `external:world` | `attendee:88` | 4500 | `payment` |

`balanceOf(attendee:88)` = (500 + 4500) − 5000 = 0 → settled, paid £45.
`balanceOf(revenue:45)` = +5000 (gross). `balanceOf(modifier:7)` = −500 — which is
exactly today's signed `modifiers.total_revenue`. Net income = revenue + modifier
= 4500.

### 7.5 Surcharge / paid add-on

A +£3 surcharge or opt-in add-on (modifier 9) — the modifier *receives* money:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `attendee:88` | `modifier:9` | 300 | `surcharge` |

`balanceOf(modifier:9)` = +300 (its revenue effect). The buyer funds it through
the normal `world → attendee:88` payment leg, which is sized to the net owed.

### 7.6 Pay-what-you-want / `can_pay_more`

No special handling: the `sale` leg is the amount the buyer chose to pay (within
the validated `[expected, max_price]` range, `webhooks.ts` unchanged), and the
`payment` leg matches it. The chosen amount is recorded as a fact, not derived
from catalogue price.

### 7.7 Provider fees & payouts (new capability — later phase)

Because the processor is a real account, fees and payouts become expressible —
impossible today. The cash-in leg's source becomes the PSP instead of the world:

| source | destination | amount | kind |
| --- | --- | --- | --- |
| `external:world` | `psp:stripe` | 5000 | `charge` |
| `psp:stripe` | `attendee:88` | 5000 | `payment` |
| `psp:stripe` | `fees:paid` | 75 | `fee` |
| `psp:stripe` | `external:world` | 4925 | `payout` |

`balanceOf(psp:stripe)` = money the processor is holding for you, reconcilable
against Stripe's reported balance. **Ship the world-funds-attendee form (§7.1)
first; add the PSP split + fees/payouts later — same table, only the mapper grows.**

### 7.8 Manual adjustment / comp / cash (admin)

Operator records a £40 cash payment, comps a ticket, or posts an opening balance:

| source | destination | amount | kind | posted_by |
| --- | --- | --- | --- | --- |
| `external:world` | `attendee:88` | 4000 | `manual` | `user:3` |

Always `posted_by` = the admin user, with a `memo`. See §10.

### 7.9 Summary

| Event | Transfer(s) | Replaces |
| --- | --- | --- |
| Booking (paid) | `attendee→revenue` + `world→attendee` | `price_paid` write + income trigger |
| Deposit | `attendee→revenue` + `world→attendee` (partial) | `remaining_balance` setup |
| Balance pay | `world→attendee` | `settleAttendeeBalance` fold/guard |
| Refund (any amount) | `revenue→attendee` + `attendee→world` | `refunded` flag |
| Discount | `modifier→attendee` | `modifier_usages.amount_applied` / `total_revenue` |
| Surcharge/add-on | `attendee→modifier` | `modifier_usages.amount_applied` / `total_revenue` |
| Fee / payout | `psp→fees` / `psp→world` | *new* |
| Manual/comp/cash | any → any | activity-log free text |

---

## 8. Attendee deletion & data retention

**Requirement: deleting an attendee must not lose their financial record.** A
first-class design constraint, and the model is well-suited to it.

### 8.1 Transfers are PII-free by construction

A transfer row contains only: account `(type, id)` pairs (integers/opaque
strings), an integer amount, a currency code, timestamps, a `kind`, a `reference`,
and `posted_by`. **No names, emails, phones, or payment references.** (Payment
references stay in the encrypted `pii_blob`, as today.) So retaining transfers
after erasing an attendee is privacy-safe.

- The library cannot police `memo`; therefore the **house rule is: `memo` is
  PII-free** (a code or short reason). If a memo must ever hold sensitive text, the
  host encrypts it before posting — but the default is PII-free.

### 8.2 Two distinct deletion semantics

1. **Order rollback** — a half-created order that never economically happened
   (e.g. capacity/stock lost the race; `consumeModifierStockOrRollback` →
   `deleteAttendee`, `modifier-usage.ts:100-108`). Guarantee: **post the order's
   transfers in the same atomic batch as attendee + `listing_attendees` +
   modifier-stock creation.** If the batch fails, nothing commits — there's no
   transfer to clean up. Where stock consumption is a separate post-creation step,
   either fold it into the same batch or have the rollback delete the just-written
   transfers **by reference** (the order's session reference), exactly as it
   already deletes `modifier_usages` by `attendee_id`. Reference-scoped cleanup
   keeps it to *this* failed order.

2. **Erasure of a real, completed attendee** (operator deletes a booking; GDPR).
   The money genuinely moved, so **the financial record must survive**:

   > `deleteAttendee` (the generic erase path) MUST NOT delete that attendee's
   > transfers.

   The attendee row and PII go; the transfers stay, now referencing a **dangling
   `attendee:<id>`** that no longer resolves. That tombstone is intended.
   Reporting renders it as "deleted attendee #<id>".

   Note: today `deleteAttendee` recomputes `listings.income` from
   `SUM(price_paid)` at delete time (`delete.ts:23`). That whole mechanism is
   removed — income is ledger-derived and erasing the attendee deliberately leaves
   the revenue transfers in place, so income is unaffected by erasure.

### 8.3 Why the no-FK / no-cascade convention helps here

The project already declares no FKs (`schema.ts:323-325`). There is no
`ON DELETE CASCADE` from `attendees` to silently take the ledger with it. The
cleanup of a *failed* order is an explicit, reference-scoped delete; the *erase*
path simply doesn't touch `transfers`.

### 8.4 Consequences for derived balances

Outstanding balance is a **live** concept for existing attendees
(`−balanceOf(attendee:A)`). An erased attendee has no outstanding-balance
reporting — correct: there's no one to owe. What we retain is the *settled
financial fact* (the revenue/cash/refund transfers), which is exactly the ledger.
Revenue/refund/net reports aggregate by `revenue:<listing>` and time, so they are
unaffected by erasure. The attendee's own `byAccount` view still resolves for the
tombstone, so an auditor can see the erased person's money history without their
identity.

---

## 9. Idempotency & concurrency

The payment path is the crown jewels: a webhook/redirect can fire more than once
for the same payment, and we must never double-credit.

### 9.1 Reference = idempotency key

Every transfer carries a `reference` with a `UNIQUE` index, and inserts use
`ON CONFLICT(reference) DO NOTHING` (§4.7). References are **deterministic
functions of the event**, so a replay regenerates the same string and the insert
no-ops. Each *leg* gets its own stable suffix:

- sale leg: `sale:{paymentSessionId}:{listingId}`
- payment leg: `pay:{paymentSessionId}`
- balance: `bal:{paymentSessionId}`
- refund legs: `refund:{paymentRef}:{seq}:rev` / `:cash`
- modifier leg: `mod:{paymentSessionId}:{modifierId}`
- manual: `manual:{uuid}` (generated once by the admin action)

This mirrors `processed_payments.payment_session_id` (`processed-payments.ts`),
which already gates the attendee-creation side.

### 9.2 Same-batch atomicity with `processed_payments`

Transfer inserts are appended to the **same `executeBatchWithResults` batch** as
attendee creation / balance settle / `processed_payments` finalize. Either all of
it commits or none does — precisely how `balanceFinalizeStatement` is already
threaded into the settle batch (`balance.ts:148-151`, `167-192`) and how guarded
modifier inserts ride the creation batch. The library's `transferStatements()`
(§6.2) exists to make the descriptors available for exactly this composition.

So the ordering guarantee is: **a payment is finalized in `processed_payments`,
the attendee is created, and the transfers are posted — atomically, once.** A
replay finds the session finalized and/or the references present, and writes
nothing.

### 9.3 No new locking

Because amounts never mutate in place (no `balance = balance + x` on a shared
row), there's no write contention to serialise beyond the unique-reference guard.
Strictly simpler than today's `remaining_balance` conditional updates.

---

## 10. Admin view & adjusting the historical record

### 10.1 Append-only is the law; corrections are first-class

Posted transfers are **immutable**. "Adjusting the historical record" is done by
**appending** transfers, never mutating or deleting rows. This keeps the ledger
auditable, keeps idempotency assumptions intact, and keeps the conservation
invariant (§3) meaningful. It is the honest reading of `AGENTS.md`'s "repairing
data should be a first-class operator action" — the repair is a recorded action,
not silent surgery.

Three operator actions, all posting new rows with `posted_by = user:<id>` and a
required `memo`:

1. **Void / reverse** a transfer → posts `reverseOf(t)` (§4.6). For a mistaken
   charge.
2. **Correct** a transfer → posts `reverseOf(t)` **and** a new corrected transfer,
   in one batch, both linked via `reverses_id`.
3. **Manual post** → an arbitrary `source → destination` transfer (record cash,
   comp a ticket, opening balances, write-offs).

Every adjustment is a normal ledger row, so it appears in reports, reconciliation,
and the audit chain (`reverses_id` links a correction to its original). A
human-readable line is also written to `activity_log`, as refunds and balance
payments do today.

### 10.2 Pages

- **`/admin/accounting`** — ledger browser: filter by account
  (attendee/listing/modifier/PSP/singleton), date range, `kind`; columns show
  source → destination, amount, time, memo, actor; footer shows period totals
  (in / out / net) from `inPeriod` + `allBalances`.
- **Account statement** — pick any account → `statementFor(account)` with a
  running balance.
- **Per-attendee money panel** — replaces the current balance panel
  (`attendee-balance.tsx`): the attendee's transfers (sale, deposit, balance,
  refund) with timestamps and the derived outstanding balance. Read-only and still
  works for a tombstoned/erased attendee's retained transfers.
- **Reconciliation** — for each PSP account, `balanceOf(psp(p))` vs the
  provider-reported balance; and a global `isConserved` assertion. Surfaces any
  invariant breach loudly, like the existing `aggregate-recalculation.ts` audit.
- **Reports** — §11.

### 10.3 On destructive edits

A true row mutation/delete is intentionally **not** offered in the normal UI. If a
hard edit is ever genuinely required (e.g. legal erasure of a mis-entered
sensitive memo), gate it behind superuser, write before/after to `activity_log`,
and re-assert `isConserved` afterward. The recommended tool in ~all cases is a
correction (10.1), which preserves the trail.

---

## 11. Reporting unlocked

Each is a narrow SQL fetch feeding a pure projection.

- **Net revenue over a period:** `inPeriod(from,to)` over `revenue:*` and
  `modifier:*` transfers; sum `allBalances` over those accounts → gross, modifier
  effect, net — by month/day via `bucketByMonth`.
- **Refunds in a period:** `byKind("refund", {from,to})` → sum.
- **Per-listing P&L:** `balanceOf(revenueOf(L))` (gross) and the modifiers/fees
  attributed to it.
- **Outstanding balances:** per live attendee, `−balanceOf(attendeeAcct(A))`;
  total across attendees.
- **Cash received vs recognised revenue:** sum the `world→*` legs vs the
  `*→revenue` legs — the accrual-vs-cash gap is the outstanding receivables total.
- **Provider reconciliation:** `balanceOf(psp(p))` vs provider statement.
- **Modifier revenue:** `balanceOf(modifierAcct(M))` — replaces
  `modifiers.total_revenue`.

The headline — **"what did I take in, refund, and net between X and Y?"** — goes
from *impossible today* to a one-liner. A flat "general journal" CSV export over a
range gives operators a clean hand-off to real accounting software.

---

## 12. Migration plan

Incremental and dual-write — the app works at every step. No big-bang cutover.

### Phase 0 — Library + table, zero behaviour change

- Build `src/shared/ledger/` (pure) with full unit/property tests. Independently
  shippable; touches no existing flow.
- Add the `transfers` table to `SCHEMA`. No writes wired. No money triggers.
- Build `src/shared/accounting/` chart of accounts + store adapter + (unit-tested)
  event mappers, not yet called from routes.

### Phase 1 — Dual-write (shadow ledger) + backfill

- In the atomic batches for booking creation (`create.ts`), balance settlement
  (`balance.ts`), refunds (`attendee-refunds.ts`), and modifier consumption, also
  post the corresponding transfers (§7) via the existing batch.
- Existing columns remain the source of truth; transfers are shadow data.
- **Backfill** historical transfers from current state (best-effort):
  - bookings → `attendee→revenue` (gross from current data) + `world→attendee`
    (from `price_paid`)
  - modifiers → `modifier→attendee` / `attendee→modifier` from `modifier_usages`
  - refunds → from `refunded` flags (amount inferred from `price_paid`; **date
    unknown**, stamped at backfill time, `occurred_at` = best estimate)
  - deposits → `world→attendee` from current `price_paid`; the **deposit/balance
    split and its dates are unrecoverable** (already folded) → one payment leg.
  - State plainly: pre-cutover history is *summarised*, not itemised.
- Add a **parity oracle** (test + admin page): for every listing,
  `balanceOf(revenueOf(L))` vs `listings.income`; for every live attendee,
  `−balanceOf(attendeeAcct(A))` vs `remaining_balance`. Run until green on real
  data.

### Phase 2 — Migrate reads

- Switch income, outstanding balance, amount-paid, refund status, and modifier
  revenue to read from the ledger. Add the period reports (§11) and admin pages
  (§10). Old columns become a parity oracle only.

### Phase 3 — Retire (the all-in cut)

- Delete every redundant money column and its trigger machinery (§14). After this
  the ledger is the *only* money store.
- Replace the `settleAttendeeBalance` fold with a plain `world→attendee` append.
- Demote `modifier_usages` to a pure stock ledger (drop `amount_applied`).

Each phase is a normal PR that passes `deno task precommit` (typecheck, lint, 0%
duplication, 100% coverage) on its own.

---

## 13. Testing strategy

The split is deliberate: most logic is pure and trivially coverable; the risky
integration surface is small and gets focused tests.

### Pure library (the bulk of the code)

- **Table-driven** validation tests (every `LedgerError`, boundary amounts).
- **Property/metamorphic** tests over projections:
  - `balanceOf(A)` == `Σ in − Σ out` for random transfer sets.
  - `isConserved` holds for any set built from balanced transfers.
  - `reverseOf(t)` posted ⇒ both endpoints net unchanged.
  - period buckets partition the set (nothing double-counted or dropped).
  - order-independence: shuffling input doesn't change `allBalances`.
- 100% coverage falls out because the functions are pure and total.

### Integration (small, high-value)

Per `AGENTS.md`'s critical-flow mandate (idempotency, concurrency, negative-path,
mutation resistance), with `#test-utils` + a real test DB (`server-balance.test.ts`
is the template):

- **No double-credit on replay:** process the same session twice ⇒ exactly one set
  of transfers; `revenue` charged once.
- **Atomicity:** force the creation batch to fail (capacity) ⇒ no transfer rows.
- **Deposit→balance:** deposit then settle ⇒ derived outstanding hits zero, no row
  mutated, both legs visible with timestamps.
- **Partial refunds:** two partial refunds sum correctly; net income reflects
  them; a refund exceeding paid is rejected.
- **Receivable correctness:** `−balanceOf(attendee)` equals the old
  `remaining_balance` across a matrix of deposit/discount/surcharge cases.
- **Erasure retains transfers:** create a paid attendee, post transfers, delete
  the attendee ⇒ transfers remain; `byAccount` still returns them; no PII in any
  retained row; income unchanged.
- **Order rollback removes transfers:** stock lost-race rollback ⇒ that order's
  transfers gone (by reference), others untouched.
- **Backfill parity:** post-backfill, ledger-derived income == `listings.income`
  and ledger outstanding == `remaining_balance` for every row.

### Determinism

`occurredAt`/`recordedAt`/references are injected (`nowIso`, deterministic ref
builders) — no time flakiness, and every branch gets a direct in-process test, not
incidental subprocess coverage (per `AGENTS.md`).

---

## 14. What this retires — the definitive removal list

We are **all-in**: once Phase 2 migrates the reads, Phase 3 deletes the following.
Each line names the readers that must move to a ledger-derived value first (the
"verify" step), then the column/trigger is dropped. **No money column survives.**

| Removed | Type | Becomes | Readers to migrate first |
| --- | --- | --- | --- |
| `listing_attendees.price_paid` | money | `world→attendee` cash legs; per-line = `attendee→revenue` sale leg | `balance.ts` order summary; `queries.ts` `ATTENDEE_COLS`/detail/list; `atomic-update.ts`; `capacity.ts` insert; `delete.ts:23` income recompute; `attendee-merge.ts`; confirmation email; scanner; attendees CSV; `webhooks.ts` create |
| `attendees.remaining_balance` | money | `−balanceOf(attendee:A)` | `balance.ts`; `attendee-balance.ts`; public `balance.ts`; webhooks |
| `attendees.price_paid` (TEXT, in `pii_blob`) | money snapshot | sum of attendee cash legs (derive for the confirmation email) | `pii.ts:98`; `create.ts:106`; confirmation email/templates |
| `listing_attendees.refunded` | money flag | refund legs exist / their sum (**enables partial refunds**) | `queries.ts`; `atomic-update.ts`; scanner; attendee detail badge; refund guard in `attendee-refunds.ts` |
| `listings.income` + income leg of `LISTING_AGGREGATE_TRIGGERS` | money | `balanceOf(revenueOf(L))` | `stats.ts`; dashboard; listings CSV; `listings.ts` cache load |
| `modifiers.total_revenue` | money | `balanceOf(modifierAcct(M))` | `modifiers.ts` recalculation; modifiers admin page |
| `modifiers.total_uses`, `modifiers.usage_count` + `MODIFIER_AGGREGATE_TRIGGERS` | counts (engagement) | live `COUNT(*)`/`SUM(quantity)` over the retained stock ledger | modifiers admin page; recalculation |
| `modifier_usages.amount_applied` | money | `modifier:M` transfers | `modifier-usage.ts`; webhooks consume |
| `settleAttendeeBalance` fold UPDATE (`balance.ts:180-183`) | money mutation | append a `world→attendee` transfer | — |
| money lines in `activity_log` (free text) | money log | structured transfers (+ a human summary line stays) | refund/balance log sites |

### Explicitly **kept** (not money — do not remove)

- `listing_attendees.quantity`, `listings.booked_quantity`, `listings.tickets_count`
  and the **capacity** part of `LISTING_AGGREGATE_TRIGGERS` — these are seats, not
  money. The trigger set is rewritten to maintain only the count/quantity columns;
  `LISTING_AGGREGATE_WRITE_COLUMNS` drops `price_paid` (now gone).
- `modifier_usages` rows themselves (`modifier_id, attendee_id, quantity, created`)
  — the **stock ledger**. The live stock check already sums `quantity`
  (`modifier-usage.ts:26-36`) and is untouched. Only its money column leaves.
- `listings.unit_price`, `day_prices`, `max_price`, `can_pay_more`,
  `attendee_statuses.reservation_amount` — these are **pricing configuration**
  (the catalogue), not records of money that moved.

Net: **four bespoke money mechanisms + their trigger sets collapse into one table
+ a pure library, with the attendee promoted to an account so nothing about
"paid" or "owed" needs a stored column.** That is the "simplify some code" payoff,
in full.

---

## 15. Decisions (resolved)

1. **All-in, no parallel money state.** Every money column is removed (§14). Any
   future cached aggregate must be a ledger-rebuilt cache with a recalculation
   endpoint — never a second source of truth.
2. **Recognition at sale, gross.** Revenue is recognised when the booking is made
   (matches today); modifiers adjust via their own account. Income headline =
   recognised net revenue (§3). A deferred-to-event-date accrual variant
   (`deposits:held` liability that releases to `revenue` on the event date) is a
   later, opt-in refinement — the `DEPOSITS` account type is reserved for it.
3. **Derive first, cache only if measured.** Start with derived `SUM`s; add a
   ledger-rebuilt cache only where profiling proves a hot path needs it.
4. **`modifier_usages` stays as a stock ledger**, money stripped out (§14). Stock
   ≠ money, so it doesn't belong in the transfer ledger.
5. **Single currency** enforced; the `currency` column exists and the library
   refuses mixed-currency sums.
6. **PSP split & fees/payouts** (§7.7) are a later additive phase — no schema
   change, only richer mappers.
7. **Corrections-only** for adjustments (§10.3); a destructive hard-edit is a
   guarded superuser exception, not a normal tool.

---

## 16. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Double-credit on webhook replay | High | Same-batch insert with `processed_payments`; `UNIQUE(reference)` + `ON CONFLICT DO NOTHING`; explicit replay test (§13). |
| Removing `price_paid`/`refunded` touches many readers | Medium (wide) | Phased dual-write: migrate every reader to a ledger value in Phase 2, parity-checked, before dropping the column in Phase 3. The reader list is enumerated in §14. |
| Income semantics shift (cash-paid → recognised) | Medium | Documented and intended (§3); the parity oracle compares against the old number during migration so the change is visible and deliberate, not accidental. |
| Money/capacity entangled (dropping `refunded`/`price_paid` breaks seats or stock) | High | Ledger is money-only; seats stay on `listing_attendees`, stock stays in `modifier_usages`; the capacity triggers are kept and rewritten to drop only the income leg (§14). |
| Backfill loses deposit/refund detail | Certain (accepted) | Best-effort opening transfers; documented that pre-cutover history is summarised; parity oracle against old columns. |
| Cascade accidentally deletes a tombstoned attendee's transfers | High | No FKs/cascade (existing convention); erase path never touches `transfers`; rollback deletes only by order reference; explicit erasure-retention test. |
| Coverage/duplication gates on a big change | Medium | Pure core makes 100% coverage cheap; phase the work so each PR is small and self-contained. |
| Derived `SUM` too slow at scale | Low/Med | Narrow indexed queries (account/period); add a ledger-rebuilt cache with a recalculation endpoint if profiling demands. |
| PII leaking into `memo` | Low | House rule: `memo` is PII-free; host encrypts if it must hold sensitive text; transfers otherwise carry only ids + amounts. |

---

### One-paragraph summary

Introduce a single append-only `transfers` table — money moving from a typed
source account to a typed destination account, positive amounts, with hardcoded
ids for singletons like the outside world and each payment processor. Promote the
attendee to a first-class account (a receivable) so "paid" and "owed" are derived,
not stored. Front it with a small, pure, context-free library
(`src/shared/ledger/`) doing validation, balance/statement/period projection,
reversals, and statement-descriptor construction, driven through a thin host glue
(`src/shared/accounting/`) holding the chart of accounts and event mappers. We go
all-in: income, outstanding balance, amount-paid, refunds, and modifier revenue
all become `SUM` over the ledger, and **every** redundant money column and its
triggers are deleted (§14) — `price_paid`, `remaining_balance`, the encrypted
paid-snapshot, the `refunded` flag, `listings.income`, and the modifier money
aggregates — leaving the ledger as the sole accounting store. Transfers are
PII-free and never cascade-deleted, so an attendee's financial record survives
their erasure. An admin view inspects the ledger and adjusts history the only safe
way — by appending corrections. Ship it incrementally (library → dual-write +
backfill → migrate reads → retire), with the single must-get-right being that the
transfer insert shares the atomic, `processed_payments`-guarded batch on the
payment path.
