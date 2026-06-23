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
