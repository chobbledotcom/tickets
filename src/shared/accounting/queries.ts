/**
 * Read queries over the transfers ledger.
 *
 * The figures that used to be stored on domain rows (an attendee's balance, a
 * listing's income, a modifier's revenue) are worked out from the ledger here.
 * The balance queries add up signed amounts in SQL rather than loading every
 * transfer into memory: each transfer adds its amount to the destination account
 * and subtracts it from the source account, so an account's balance is the sum
 * of those signed rows. The ledger only ever holds one currency (the write path
 * enforces it), so adding amounts up is always safe.
 */

import type { InValue } from "@libsql/client";
import {
  ATTENDEE,
  COST,
  EXTERNAL,
  FEE_INCOME,
  MODIFIER,
  REVENUE,
  WRITEOFF_TYPE,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_LISTING_INCOME } from "#accounting/manual-entries.ts";
import {
  accountBalanceSubquery,
  attendeeOwedSubquery,
  creditsLessWriteoffDebits,
  LEG_COLUMNS,
  signedSumCase,
} from "#accounting/projection-sql.ts";
import { type LedgerRange, occurredAtRange } from "#accounting/range.ts";
import {
  fromDb,
  selectByEventGroup,
  selectTransfers,
} from "#accounting/rows.ts";
import {
  inPlaceholders,
  queryAll,
  requireOne,
  resultRows,
  rowExists,
  type TxScope,
} from "#db/client.ts";
import { clauseArgs, type WhereClause, whereSql } from "#db/where-clauses.ts";
import { requiredMapValue, uniqueBy } from "#fp";
import { accountKey } from "#shared/ledger/account.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";

/** Newest first by business time, ties broken by id so the order is stable. */
const NEWEST_FIRST = "occurred_at DESC, id DESC";

/** A parameterised "this leg's <role> side IS the account" match — two bound `?`
 *  for (type, id), built from the shared transfers column names so every balance
 *  read filters accounts identically. */
const legMatchesAccount = (role: "source" | "dest"): string =>
  `${LEG_COLUMNS[role].type} = ? AND ${LEG_COLUMNS[role].id} = ?`;

const accountsScope = (accounts: readonly AccountRef[]): WhereClause => {
  const parts = [...Map.groupBy(accounts, ({ type }) => type)].map(
    ([type, sameType]) => {
      const ids = sameType.map(({ id }) => id);
      const placeholders = inPlaceholders(ids);
      return {
        args: [type, ...ids, type, ...ids],
        clause:
          `(${LEG_COLUMNS.source.type} = ? AND ${LEG_COLUMNS.source.id} IN (${placeholders})) OR ` +
          `(${LEG_COLUMNS.dest.type} = ? AND ${LEG_COLUMNS.dest.id} IN (${placeholders}))`,
      };
    },
  );
  return {
    args: parts.flatMap(({ args }) => args),
    clause: parts.map(({ clause }) => `(${clause})`).join(" OR "),
  };
};

/** Every transfer touching any requested account, grouped by account key. */
export const transfersByAccounts = async (
  accounts: readonly AccountRef[],
): Promise<ReadonlyMap<string, Transfer[]>> => {
  const requested = uniqueBy(accountKey)([...accounts]);
  if (requested.length === 0) return new Map();
  const wanted = new Set(requested.map(accountKey));
  const transfers = await selectTransfers(fromDb, {
    where: [accountsScope(requested)],
  });
  const touching = transfers.flatMap((transfer) =>
    uniqueBy(accountKey)([transfer.source, transfer.destination])
      .filter((account) => wanted.has(accountKey(account)))
      .map((account) => ({ key: accountKey(account), transfer })),
  );
  const byAccount = Map.groupBy(touching, ({ key }) => key);
  return new Map(
    requested.map((account) => {
      const key = accountKey(account);
      return [key, (byAccount.get(key) ?? []).map(({ transfer }) => transfer)];
    }),
  );
};

/** Every transfer touching `account`, as source or destination. */
export const transfersByAccount = async (
  account: AccountRef,
): Promise<Transfer[]> =>
  requiredMapValue(
    await transfersByAccounts([account]),
    accountKey(account),
    `Transfer read omitted requested account ${accountKey(account)}`,
  );

/** Every leg of one business event (booking, refund, …). */
export const transfersByEventGroup = (
  eventGroup: string,
): Promise<Transfer[]> => selectByEventGroup(fromDb, eventGroup);

/**
 * True when the ledger already holds at least one leg for this business event —
 * the cheap existence probe a money move runs as a PREFLIGHT before acting. The
 * transfers ledger is the durable record of what already happened (unlike the
 * prunable processed_payments idempotency row), so booking a paid session,
 * settling a balance, or refunding one all consult this first: an event the
 * ledger already records is replayed, never double-posted or refunded again.
 */
export const eventGroupHasLegs = (eventGroup: string): Promise<boolean> =>
  rowExists("SELECT 1 FROM transfers WHERE event_group = ? LIMIT 1", [
    eventGroup,
  ]);

/** The whole ledger. For tests and small reports; scoped reads are preferred on
 *  hot paths. */
export const allTransfers = (): Promise<Transfer[]> => selectTransfers(fromDb);

/** The most recent `limit` transfers, newest first (by business time then id, so
 *  ties are stable). The ordering + limit run in SQL so the whole ledger is never
 *  loaded into memory; `occurred_at` is the stored INTEGER epoch, so DESC is
 *  newest-first. */
export const recentTransfers = (limit: number): Promise<Transfer[]> =>
  selectTransfers(fromDb, { limit, order: NEWEST_FIRST });

/** Legs shown on the operator-facing ledger list. Routine checkout cash
 * plumbing ("Card / bank → <attendee>" and its refund mirror) stays hidden, but
 * owner-entered manual rows and service cost legs remain visible even when they
 * record an external cost. */
const VISIBLE_TRANSFER_SCOPE =
  `(source_type != '${EXTERNAL}' AND dest_type != '${EXTERNAL}'` +
  ` OR kind LIKE 'manual\\_%' ESCAPE '\\' OR kind = '${KIND.serviceCost}')`;

/** A listing-account scope (revenue OR cost legs touching this listing's
 *  accounts) for the by-listing filter, with its bound args. Empty for "all
 *  listings". Cost legs use source_type/dest_type='cost' rather than 'revenue',
 *  so both types are included so service-cost legs appear in the listing view. */
const listingLegScope = (
  listingIds: readonly number[] | null,
): WhereClause[] => {
  if (listingIds === null) return [];
  // Asking for no listings can match no leg, so the read is skipped entirely.
  if (listingIds.length === 0) {
    return [{ args: [], clause: "0", matchesNothing: true }];
  }
  return [
    {
      args: Array(4)
        .fill(listingIds.map((id) => String(id)))
        .flat(),
      clause:
        `(dest_type = '${REVENUE}' AND dest_id IN (${inPlaceholders(
          listingIds,
        )})` +
        ` OR source_type = '${REVENUE}' AND source_id IN (${inPlaceholders(
          listingIds,
        )})` +
        ` OR source_type = '${COST}' AND source_id IN (${inPlaceholders(
          listingIds,
        )})` +
        ` OR dest_type = '${COST}' AND dest_id IN (${inPlaceholders(
          listingIds,
        )}))`,
    },
  ];
};

/**
 * The visible transfer list for the operator ledger: newest first, capped at
 * `limit`, hiding routine `external:world` cash legs, bounded to `range`, and
 * optionally scoped to one listing's `revenue` account. Owner-entered manual
 * external rows stay visible. Ordering + limit run in SQL so the whole ledger is
 * never loaded.
 */
export const visibleTransfers = (
  range: LedgerRange,
  listingIds: readonly number[] | null,
  limit: number,
): Promise<Transfer[]> => {
  const parts: WhereClause[] = [
    { args: [], clause: VISIBLE_TRANSFER_SCOPE },
    ...occurredAtRange(range),
    ...listingLegScope(listingIds),
  ];
  return selectTransfers(fromDb, { limit, order: NEWEST_FIRST, where: parts });
};

/** Distinct-day bounds (earliest/latest `occurred_at`) over the whole ledger, or
 *  null when it is empty — the span the date-range pickers offer as selectable. */
export const transferActivityBounds = async (): Promise<{
  minMs: number;
  maxMs: number;
} | null> => {
  // An ungrouped aggregate always yields exactly one row; MIN and MAX are NULL
  // together iff the table is empty.
  const row = await requireOne<{
    min_ms: number | bigint | null;
    max_ms: number | bigint | null;
  }>(
    "SELECT MIN(occurred_at) AS min_ms, MAX(occurred_at) AS max_ms FROM transfers",
    [],
  );
  if (row.min_ms === null || row.max_ms === null) return null;
  return { maxMs: Number(row.max_ms), minMs: Number(row.min_ms) };
};

/** The headline figures the ledger stats table shows for a range. */
export type LedgerTotals = {
  /** Recognised revenue across all listings (gross sales ± write-off adjustments). */
  income: number;
  /** Net receivable arising in the range (Σ attendee debits − credits). */
  due: number;
  /** Cash handed back (`refund_cash` legs). */
  refunded: number;
  /** Net booking-fee income (`fee` credits − `refund_fee` debits). */
  fees: number;
};

type LedgerTotalsRow = {
  income: number | bigint;
  due: number | bigint;
  refunded: number | bigint;
  fees: number | bigint;
};

/**
 * The four headline ledger figures over `range`, in one grouped scan:
 *
 * - `income` — recognised revenue: `sale` and owner-entered external-income
 *   credits to any `revenue` account, plus write-up `adjustment`s from
 *   `writeoff`, minus write-down `adjustment`s to `writeoff` (matching the
 *   per-listing `listingMoneyTotals`).
 * - `due` — net receivable: a leg *out of* an attendee (a sale/fee they owe) adds,
 *   a leg *into* an attendee (a payment) subtracts. Over "forever" this is exactly
 *   the current total outstanding.
 * - `refunded` — Σ `refund_cash` amounts (cash returned to the world).
 * - `fees` — net booking-fee income: credits to `fee_income` less its refunds.
 */
export const ledgerTotals = async (
  range: LedgerRange,
): Promise<LedgerTotals> => {
  const parts = occurredAtRange(range);
  // An ungrouped aggregate always yields exactly one row.
  const row = await requireOne<LedgerTotalsRow>(
    `SELECT
       COALESCE(SUM(CASE
         WHEN kind = '${KIND.sale}' AND dest_type = '${REVENUE}' THEN amount
         WHEN kind = '${MANUAL_LISTING_INCOME}' AND dest_type = '${REVENUE}' THEN amount
         WHEN kind = '${KIND.adjustment}' AND dest_type = '${REVENUE}' AND source_type = '${WRITEOFF_TYPE}' THEN amount
         WHEN kind = '${KIND.adjustment}' AND source_type = '${REVENUE}' AND dest_type = '${WRITEOFF_TYPE}' THEN -amount
         ELSE 0 END), 0) AS income,
       ${signedSumCase(
         `source_type = '${ATTENDEE}'`,
         `dest_type = '${ATTENDEE}'`,
       )} AS due,
       COALESCE(SUM(CASE WHEN kind = '${KIND.refundCash}' THEN amount ELSE 0 END), 0) AS refunded,
       ${signedSumCase(
         `dest_type = '${FEE_INCOME}'`,
         `source_type = '${FEE_INCOME}'`,
       )} AS fees
     FROM transfers${whereSql(parts)}`,
    clauseArgs(parts),
  );
  return {
    due: Number(row.due),
    fees: Number(row.fees),
    income: Number(row.income),
    refunded: Number(row.refunded),
  };
};

type BalanceRow = { id: string; balance: number | bigint };

/** Net balances grouped by account id. Each transfer counts as +amount for its
 *  destination and -amount for its source; `whereDest`/`whereSource` pick which
 *  accounts to include. This one query backs every balance read below. */
const groupedBalances = (
  whereDest: string,
  whereSource: string,
  args: InValue[],
): Promise<BalanceRow[]> =>
  queryAll<BalanceRow>(
    `SELECT id, COALESCE(SUM(delta), 0) AS balance FROM (
       SELECT ${LEG_COLUMNS.dest.id} AS id, amount AS delta FROM transfers WHERE ${whereDest}
       UNION ALL
       SELECT ${LEG_COLUMNS.source.id} AS id, -amount AS delta FROM transfers WHERE ${whereSource}
     ) GROUP BY id`,
    args,
  );

const toBalanceMap = (rows: BalanceRow[]): Map<string, number> =>
  new Map(rows.map((row) => [row.id, Number(row.balance)]));

/**
 * Balance of every account of one type (e.g. all `attendee` balances, or all
 * `revenue` listing incomes), keyed by account id, in a single query. Accounts
 * with no transfers are simply absent (balance 0).
 */
export const accountBalancesOfType = async (
  type: string,
): Promise<Map<string, number>> =>
  toBalanceMap(
    await groupedBalances(
      `${LEG_COLUMNS.dest.type} = ?`,
      `${LEG_COLUMNS.source.type} = ?`,
      [type, type],
    ),
  );

/**
 * Balance of each given account id of one type, in a single query — for a page
 * of attendees/listings rather than the whole type. An empty id list is a no-op
 * (no query); ids absent from the result have balance 0.
 */
export const accountBalancesForIds = async (
  type: string,
  ids: readonly string[],
): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const placeholders = inPlaceholders(ids);
  return toBalanceMap(
    await groupedBalances(
      `${LEG_COLUMNS.dest.type} = ? AND ${LEG_COLUMNS.dest.id} IN (${placeholders})`,
      `${LEG_COLUMNS.source.type} = ? AND ${LEG_COLUMNS.source.id} IN (${placeholders})`,
      [type, ...ids, type, ...ids],
    ),
  );
};

/** Balance of one account: money in (as destination) minus money out (as
 *  source), summed in SQL. Zero when the account has no transfers — a direct
 *  scalar read rather than the grouped many-account query, so it shares the same
 *  `legMatchesAccount` filter the rest of this module uses. */
export const accountBalance = async (acct: AccountRef): Promise<number> => {
  const asDest = legMatchesAccount("dest");
  const asSource = legMatchesAccount("source");
  // Each predicate binds (type, id) and appears four times — both CASE arms and
  // both WHERE arms — so the account's pair repeats four times, in that order.
  const pair: InValue[] = [acct.type, acct.id];
  const row = await requireOne<{ balance: number | bigint }>(
    `SELECT ${signedSumCase(asDest, asSource)} AS balance` +
      ` FROM transfers WHERE ${asDest} OR ${asSource}`,
    [...pair, ...pair, ...pair, ...pair],
  );
  return Number(row.balance);
};

/**
 * Read a single projected money figure (a scalar `transfers` subquery) THROUGH an
 * open write transaction, so the figure reflects this transaction's own
 * uncommitted legs and — crucially — is read under the write lock. A correction
 * that recomputes its delta from a freshly-read current figure inside the same
 * transaction it posts into is therefore idempotent: a second submit of the same
 * target reads the first's committed adjustment and computes a zero delta. The
 * subquery interpolates the (numeric, validated) row id as a SQL expression, the
 * same convention the projection-sql builders use, so it carries no bound args.
 */
const readProjectedFigureTx = async (
  tx: TxScope,
  subquery: string,
): Promise<number> => {
  const rows = resultRows<{ figure: number | bigint }>(
    await tx.execute({ args: [], sql: `SELECT ${subquery} AS figure` }),
  );
  return Number(rows[0]!.figure);
};

/** What an attendee currently owes (−balanceOf(attendee)) read in-transaction. */
export const attendeeOwedTx = (
  tx: TxScope,
  attendeeId: number,
): Promise<number> =>
  readProjectedFigureTx(tx, attendeeOwedSubquery(String(attendeeId)));

/** A listing's currently projected income (gross credits less write-off debits)
 *  read in-transaction — the figure {@link adjustListingIncome} corrects. */
export const listingIncomeTx = (
  tx: TxScope,
  listingId: number,
): Promise<number> =>
  readProjectedFigureTx(
    tx,
    creditsLessWriteoffDebits(REVENUE, String(listingId)),
  );

/** A modifier's currently projected net revenue (balanceOf(modifier)) read
 *  in-transaction — the figure {@link adjustModifierRevenue} corrects. */
export const modifierRevenueTx = (
  tx: TxScope,
  modifierId: number,
): Promise<number> =>
  readProjectedFigureTx(
    tx,
    accountBalanceSubquery(MODIFIER, String(modifierId)),
  );
