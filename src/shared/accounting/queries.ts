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
  accountBalanceSubquery,
  attendeeOwedSubquery,
  creditsLessWriteoffDebits,
  LEG_COLUMNS,
} from "#shared/accounting/projection-sql.ts";
import {
  andPrefixed,
  type LedgerRange,
  occurredAtRange,
  wherePrefixed,
} from "#shared/accounting/range.ts";
import {
  fromDb,
  selectByEventGroup,
  selectTransfers,
} from "#shared/accounting/rows.ts";
import {
  inPlaceholders,
  queryAll,
  resultRows,
  type TxScope,
} from "#shared/db/client.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";

/** A parameterised "this leg's <role> side IS the account" match — two bound `?`
 *  for (type, id), built from the shared transfers column names so every balance
 *  read filters accounts identically. */
const legMatchesAccount = (role: "source" | "dest"): string =>
  `${LEG_COLUMNS[role].type} = ? AND ${LEG_COLUMNS[role].id} = ?`;

/** Every transfer touching `account`, as source or destination. */
export const transfersByAccount = (acct: AccountRef): Promise<Transfer[]> =>
  selectTransfers(
    fromDb,
    ` WHERE (${legMatchesAccount("source")}) OR (${legMatchesAccount("dest")})`,
    [acct.type, acct.id, acct.type, acct.id],
  );

/** Every leg of one business event (booking, refund, …). */
export const transfersByEventGroup = (
  eventGroup: string,
): Promise<Transfer[]> => selectByEventGroup(fromDb, eventGroup);

/** The whole ledger. For tests and small reports; scoped reads are preferred on
 *  hot paths. */
export const allTransfers = (): Promise<Transfer[]> =>
  selectTransfers(fromDb, "", []);

/** The most recent `limit` transfers, newest first (by business time then id, so
 *  ties are stable). The ordering + limit run in SQL so the whole ledger is never
 *  loaded into memory; `occurred_at` is the stored INTEGER epoch, so DESC is
 *  newest-first. */
export const recentTransfers = (limit: number): Promise<Transfer[]> =>
  selectTransfers(fromDb, " ORDER BY occurred_at DESC, id DESC LIMIT ?", [
    limit,
  ]);

/** Legs whose source AND destination are both internal — i.e. NOT the
 *  `external:world` cash account. The operator-facing ledger list hides cash
 *  plumbing ("Card / bank → <attendee>" and its refund mirror), so this is the
 *  base scope of every visible row. */
const EXCLUDE_EXTERNAL =
  "source_type != 'external' AND dest_type != 'external'";

/** A revenue-account scope (the listing's own legs, as source or destination)
 *  for the by-listing filter, with its bound args. Empty for "all listings". */
const revenueLegScope = (
  listingId: number | null,
): { clause: string; args: InValue[] } =>
  listingId === null
    ? { args: [], clause: "" }
    : {
        args: [String(listingId), String(listingId)],
        clause:
          " AND (dest_type = 'revenue' AND dest_id = ?" +
          " OR source_type = 'revenue' AND source_id = ?)",
      };

/**
 * The visible transfer list for the operator ledger: newest first, capped at
 * `limit`, hiding every `external:world` cash leg, bounded to `range`, and
 * optionally scoped to one listing's `revenue` account. Ordering + limit run in
 * SQL so the whole ledger is never loaded.
 */
export const visibleTransfers = (
  range: LedgerRange,
  listingId: number | null,
  limit: number,
): Promise<Transfer[]> => {
  const r = occurredAtRange(range);
  const listing = revenueLegScope(listingId);
  return selectTransfers(
    fromDb,
    ` WHERE ${EXCLUDE_EXTERNAL}${andPrefixed(r.clause)}${listing.clause}` +
      " ORDER BY occurred_at DESC, id DESC LIMIT ?",
    [...r.args, ...listing.args, limit],
  );
};

/** Distinct-day bounds (earliest/latest `occurred_at`) over the whole ledger, or
 *  null when it is empty — the span the date-range pickers offer as selectable. */
export const transferActivityBounds = async (): Promise<{
  minMs: number;
  maxMs: number;
} | null> => {
  const rows = await queryAll<{
    min_ms: number | bigint | null;
    max_ms: number | bigint | null;
  }>(
    "SELECT MIN(occurred_at) AS min_ms, MAX(occurred_at) AS max_ms FROM transfers",
    [],
  );
  const row = rows[0];
  if (!row || row.min_ms === null || row.max_ms === null) return null;
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
 * - `income` — recognised revenue: `sale` credits to any `revenue` account, plus
 *   write-up `adjustment`s from `writeoff`, minus write-down `adjustment`s to
 *   `writeoff` (matching the per-listing {@link listingRevenueBreakdown}).
 * - `due` — net receivable: a leg *out of* an attendee (a sale/fee they owe) adds,
 *   a leg *into* an attendee (a payment) subtracts. Over "forever" this is exactly
 *   the current total outstanding.
 * - `refunded` — Σ `refund_cash` amounts (cash returned to the world).
 * - `fees` — net booking-fee income: credits to `fee_income` less its refunds.
 */
export const ledgerTotals = async (
  range: LedgerRange,
): Promise<LedgerTotals> => {
  const r = occurredAtRange(range);
  const rows = await queryAll<LedgerTotalsRow>(
    `SELECT
       COALESCE(SUM(CASE
         WHEN kind = 'sale' AND dest_type = 'revenue' THEN amount
         WHEN kind = 'adjustment' AND dest_type = 'revenue' AND source_type = 'writeoff' THEN amount
         WHEN kind = 'adjustment' AND source_type = 'revenue' AND dest_type = 'writeoff' THEN -amount
         ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE
         WHEN source_type = 'attendee' THEN amount
         WHEN dest_type = 'attendee' THEN -amount
         ELSE 0 END), 0) AS due,
       COALESCE(SUM(CASE WHEN kind = 'refund_cash' THEN amount ELSE 0 END), 0) AS refunded,
       COALESCE(SUM(CASE
         WHEN dest_type = 'fee_income' THEN amount
         WHEN source_type = 'fee_income' THEN -amount
         ELSE 0 END), 0) AS fees
     FROM transfers${wherePrefixed(r.clause)}`,
    r.args,
  );
  const row = rows[0]!;
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
  const rows = await queryAll<{ balance: number | bigint }>(
    `SELECT COALESCE(SUM(CASE WHEN ${asDest} THEN amount` +
      ` WHEN ${asSource} THEN -amount ELSE 0 END), 0) AS balance` +
      ` FROM transfers WHERE ${asDest} OR ${asSource}`,
    [...pair, ...pair, ...pair, ...pair],
  );
  return Number(rows[0]!.balance);
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
    creditsLessWriteoffDebits("revenue", String(listingId)),
  );

/** A modifier's currently projected net revenue (balanceOf(modifier)) read
 *  in-transaction — the figure {@link adjustModifierRevenue} corrects. */
export const modifierRevenueTx = (
  tx: TxScope,
  modifierId: number,
): Promise<number> =>
  readProjectedFigureTx(
    tx,
    accountBalanceSubquery("modifier", String(modifierId)),
  );
