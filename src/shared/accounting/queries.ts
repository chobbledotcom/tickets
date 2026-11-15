/**
 * Read queries over the transfers ledger.
 *
 * Figures once stored on domain rows (an attendee's balance, a listing's
 * income, a modifier's revenue) are worked out from the ledger here.
 * The balance queries add up signed amounts in SQL rather than loading every
 * transfer into memory. Each transfer adds its amount to the destination
 * account and subtracts it from the source account. An account's balance is
 * therefore the sum of those signed rows. The ledger only ever holds one currency (the write path
 * enforces it), so adding amounts up is always safe.
 */

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
  LEDGER_ROW,
  type Leg,
  type LegTest,
  ledgerLegs,
  modifierLeg,
  signedSum,
} from "#accounting/projection-sql.ts";
import { type LedgerRange, occurredAtRange } from "#accounting/range.ts";
import {
  selectByEventGroup,
  selectTransfers,
  selectTransfersScope,
} from "#accounting/rows.ts";
import {
  queryAll,
  queryBatch,
  requireOne,
  resultRows,
  type TxScope,
} from "#db/client.ts";
import {
  among,
  and,
  type Condition,
  desc,
  type Expr,
  equal,
  literal,
  or,
  valued,
  whereTail,
  wholeCondition,
} from "#db/select/expression.ts";
import { type SqlStatement, sql, sqlLiteral } from "#db/sql.ts";
import { groupToMap, requiredMapValue, unique, uniqueBy } from "#fp";
import { accountKey } from "#shared/ledger/account.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";

/** Newest first by business time, ties broken by id so the order is stable. */
const newestFirst = (leg: Leg): SqlStatement[] => [
  desc(leg.occurred_at),
  desc(leg.id),
];

type Side = "source" | "dest";

/** The row has an account of `type` with one of `ids` on its `side`. The type
 *  and the ids are bound, so a caller can pass an account from a request. */
const sideAmong =
  (side: Side, type: string, ids: readonly string[]): LegTest =>
  (leg) =>
    and(equal(leg[`${side}_type`], type), among(leg[`${side}_id`], ids));

/** The row has the account on its `side`. */
const sideIs =
  (side: Side, acct: AccountRef): LegTest =>
  (leg) =>
    and(
      equal(leg[`${side}_type`], acct.type),
      equal(leg[`${side}_id`], acct.id),
    );

/** The WHERE scope for "every transfer touching any of these accounts".
 *  One group per account type. */
const accountsScope = (accounts: readonly AccountRef[]): SqlStatement =>
  or(
    ...[...Map.groupBy(accounts, ({ type }) => type)].flatMap(
      ([type, sameType]) => {
        const ids = sameType.map(({ id }) => id);
        return [
          sideAmong("source", type, ids)(LEDGER_ROW),
          sideAmong("dest", type, ids)(LEDGER_ROW),
        ];
      },
    ),
  );

/** Every transfer touching any requested account, grouped by account key. */
export const transfersByAccounts = async (
  accounts: readonly AccountRef[],
): Promise<ReadonlyMap<string, Transfer[]>> => {
  const requested = uniqueBy(accountKey)([...accounts]);
  if (requested.length === 0) return new Map();
  const wanted = new Set(requested.map(accountKey));
  const transfers = await selectTransfersScope(
    queryBatch,
    accountsScope(requested),
  );
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
): Promise<Transfer[]> => selectByEventGroup(queryBatch, eventGroup);

/** One modifier's signed effect on one booking order: a surcharge adds, and a
 *  discount reduces. */
export type OrderModifierLine = { amount: number; modifierId: number };

type OrderModifierRow = {
  amount: number | bigint;
  event_group: string;
  modifier_id: number | bigint;
};

/** The modifiers that changed the price of each booking order, keyed by the
 *  order's event group. It reads the order's `modifier` legs, so each figure is
 *  the one the sale posted, and a discount keeps its minus sign. */
export const orderModifierLines = async (
  eventGroups: readonly string[],
): Promise<Map<string, OrderModifierLine[]>> => {
  const groups = unique([...eventGroups]);
  if (groups.length === 0) return new Map();
  const modifierId = (leg: Leg): Expr<number> =>
    valued(sql`CAST(${modifierLeg.accountId(leg)} AS INTEGER)`);
  const rows = await queryAll(
    ledgerLegs()
      .where((leg) => [modifierLeg.filter(leg), among(leg.event_group, groups)])
      .groupBy((leg) => [leg.event_group, modifierId(leg)])
      .orderBy((leg) => [leg.event_group, modifierId(leg)])
      .select((leg) => ({
        amount: modifierLeg.signedAmount(leg),
        event_group: leg.event_group,
        modifier_id: modifierId(leg),
      })),
  );
  return groupToMap(
    (row: OrderModifierRow) => row.event_group,
    (row: OrderModifierRow): OrderModifierLine => ({
      amount: Number(row.amount),
      modifierId: Number(row.modifier_id),
    }),
  )(rows);
};

/** The whole ledger. For tests and small reports. Scoped reads are preferred on
 *  hot paths. */
export const allTransfers = (): Promise<Transfer[]> =>
  selectTransfers(queryBatch);

/** The most recent `limit` transfers, newest first (by business time then id, so
 *  ties are stable). The ordering + limit run in SQL so the whole ledger is never
 *  loaded into memory. `occurred_at` is the stored INTEGER epoch, so DESC is
 *  newest-first. */
export const recentTransfers = (limit: number): Promise<Transfer[]> =>
  selectTransfers(queryBatch, (ledger) =>
    ledger.orderBy(newestFirst).limit(limit),
  );

/** Legs shown on the operator-facing ledger list. Routine checkout cash
 * plumbing ("Card / bank → <attendee>" and its refund mirror) stays hidden.
 * Owner-entered manual rows and service cost legs remain visible even when they
 * record an external cost. */
const VISIBLE_TRANSFER_SCOPE = wholeCondition(
  sql`(source_type != ${sqlLiteral(EXTERNAL)} AND dest_type != ${sqlLiteral(EXTERNAL)} OR kind LIKE 'manual\\_%' ESCAPE '\\' OR kind = ${sqlLiteral(KIND.serviceCost)})`,
);

/** The row has an account of `type` with one of `ids` on some side. The type
 *  is a constant of the code. */
const touchesAccounts =
  (type: string, ids: readonly string[]): LegTest =>
  (leg) =>
    or(
      and(equal(leg.dest_type, literal(type)), among(leg.dest_id, ids)),
      and(equal(leg.source_type, literal(type)), among(leg.source_id, ids)),
    );

/** The legs that touch the revenue account or the cost account of one of
 *  these listings, for the by-listing filter. A null keeps every leg. A
 *  service cost leg sits on the cost account, so both types are read. An
 *  empty list matches no leg, so the read is skipped. */
const listingLegScope =
  (listingIds: readonly number[] | null) =>
  (leg: Leg): Condition => {
    if (listingIds === null) return true;
    const ids = listingIds.map((id) => String(id));
    return or(
      touchesAccounts(REVENUE, ids)(leg),
      touchesAccounts(COST, ids)(leg),
    );
  };

/**
 * The visible transfer list for the operator ledger: newest first, capped at
 * `limit`, bounded to `range`, and optionally scoped to one listing's `revenue`
 * account. It hides routine `external:world` cash legs. Owner-entered manual
 * external rows stay visible. Ordering + limit run in SQL so the whole ledger is
 * never loaded.
 */
export const visibleTransfers = (
  range: LedgerRange,
  listingIds: readonly number[] | null,
  limit: number,
): Promise<Transfer[]> =>
  selectTransfers(queryBatch, (ledger) =>
    ledger
      .where((leg) => [
        VISIBLE_TRANSFER_SCOPE,
        ...occurredAtRange(range),
        listingLegScope(listingIds)(leg),
      ])
      .orderBy(newestFirst)
      .limit(limit),
  );

/** Distinct-day bounds (earliest/latest `occurred_at`) over the whole ledger, or
 *  null when it is empty — the span the date-range pickers offer as selectable. */
export const transferActivityBounds = async (): Promise<{
  minMs: number;
  maxMs: number;
} | null> => {
  // An ungrouped aggregate always yields exactly one row. MIN and MAX are NULL
  // together iff the table is empty.
  const row = await requireOne<{
    min_ms: number | bigint | null;
    max_ms: number | bigint | null;
  }>(
    sql`SELECT MIN(occurred_at) AS min_ms, MAX(occurred_at) AS max_ms FROM transfers`,
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
  /** Net service-event costs (Σ cost-account debits − credits for
   * `service_cost` legs). Profit reads as `income − servicingCosts`. */
  servicingCosts: number;
};

/** The row has an account of `type` on its `side`. */
const sideOfType =
  (side: Side, type: string): LegTest =>
  (leg) =>
    equal(leg[`${side}_type`], literal(type));

type LedgerTotalsRow = {
  income: number | bigint;
  due: number | bigint;
  refunded: number | bigint;
  fees: number | bigint;
  servicing_costs: number | bigint;
};

/**
 * The four headline ledger figures over `range`, in one grouped scan. Each is
 * defined by its leg direction rather than by a status column:
 *
 * - `income` counts write-up `adjustment`s from `writeoff` and subtracts
 *   write-downs to it, which is what makes it match `listingMoneyTotals`.
 * - `due` adds a leg *out of* an attendee and subtracts a leg *into* one. Over
 *   "forever" that is exactly the current total outstanding.
 */
export const ledgerTotals = async (
  range: LedgerRange,
): Promise<LedgerTotals> => {
  const parts = occurredAtRange(range);
  // An ungrouped aggregate always yields exactly one row.
  const row = await requireOne<LedgerTotalsRow>(
    sql`SELECT
       COALESCE(SUM(CASE
         WHEN kind = ${sqlLiteral(KIND.sale)} AND dest_type = ${sqlLiteral(REVENUE)} THEN amount
         WHEN kind = ${sqlLiteral(KIND.taxSale)} AND dest_type = ${sqlLiteral(REVENUE)} THEN amount
         WHEN kind = ${sqlLiteral(KIND.taxSale)} AND source_type = ${sqlLiteral(REVENUE)} THEN -amount
         WHEN kind = ${sqlLiteral(MANUAL_LISTING_INCOME)} AND dest_type = ${sqlLiteral(REVENUE)} THEN amount
         WHEN kind = ${sqlLiteral(KIND.adjustment)} AND dest_type = ${sqlLiteral(REVENUE)} AND source_type = ${sqlLiteral(WRITEOFF_TYPE)} THEN amount
         WHEN kind = ${sqlLiteral(KIND.adjustment)} AND source_type = ${sqlLiteral(REVENUE)} AND dest_type = ${sqlLiteral(WRITEOFF_TYPE)} THEN -amount
         ELSE 0 END), 0) AS income,
       ${signedSum(sideOfType("source", ATTENDEE), sideOfType("dest", ATTENDEE))(LEDGER_ROW)} AS due,
       COALESCE(SUM(CASE WHEN kind = ${sqlLiteral(KIND.refundCash)} THEN amount ELSE 0 END), 0) AS refunded,
       ${signedSum(sideOfType("dest", FEE_INCOME), sideOfType("source", FEE_INCOME))(LEDGER_ROW)} AS fees,
       COALESCE(SUM(CASE WHEN kind = ${sqlLiteral(KIND.serviceCost)} AND source_type = ${sqlLiteral(COST)} THEN amount ELSE 0 END
                  - CASE WHEN kind = ${sqlLiteral(KIND.serviceCost)} AND dest_type = ${sqlLiteral(COST)} THEN amount ELSE 0 END), 0) AS servicing_costs
     FROM transfers AS transfer${whereTail(parts)}`,
  );
  return {
    due: Number(row.due),
    fees: Number(row.fees),
    income: Number(row.income),
    refunded: Number(row.refunded),
    servicingCosts: Number(row.servicing_costs),
  };
};

type BalanceRow = { id: string; balance: number | bigint };

/** Net balances grouped by account id. Each transfer counts as +amount for its
 *  destination and -amount for its source. `whereDest`/`whereSource` pick which
 *  accounts to include. This one query backs every balance read below. */
const groupedBalances = (
  whereDest: LegTest,
  whereSource: LegTest,
): Promise<BalanceRow[]> =>
  queryAll<BalanceRow>(
    sql`SELECT id, COALESCE(SUM(delta), 0) AS balance FROM (
       SELECT ${LEDGER_ROW.dest_id} AS id, amount AS delta FROM transfers AS transfer WHERE ${whereDest(LEDGER_ROW)}
       UNION ALL
       SELECT ${LEDGER_ROW.source_id} AS id, -amount AS delta FROM transfers AS transfer WHERE ${whereSource(LEDGER_ROW)}
     ) GROUP BY id`,
  );

const toBalanceMap = (rows: BalanceRow[]): Map<string, number> =>
  new Map(rows.map((row) => [row.id, Number(row.balance)]));

/**
 * Balance of each given account id of one type, in a single query — for a page
 * of attendees/listings rather than the whole type. An empty id list is a no-op
 * (no query). Ids absent from the result have balance 0.
 */
export const accountBalancesForIds = async (
  type: string,
  ids: readonly string[],
): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  return toBalanceMap(
    await groupedBalances(
      sideAmong("dest", type, ids),
      sideAmong("source", type, ids),
    ),
  );
};

/** Balance of one account: money in (as destination) minus money out (as
 *  source), summed in SQL. Zero when the account has no transfers. This is a
 *  direct scalar read rather than the grouped many-account query, so it shares
 *  the same `sideIs` test the rest of this module uses. */
export const accountBalance = async (acct: AccountRef): Promise<number> => {
  const asDest = sideIs("dest", acct);
  const asSource = sideIs("source", acct);
  const row = await requireOne(
    ledgerLegs()
      .where((leg) => or(asDest(leg), asSource(leg)))
      .select((leg) => ({ balance: signedSum(asDest, asSource)(leg) })),
  );
  return Number(row.balance);
};

/**
 * Read a single projected money figure (a scalar `transfers` subquery) THROUGH an
 * open write transaction. The figure then reflects this transaction's own
 * uncommitted legs and — crucially — is read under the write lock. A correction
 * that recomputes its delta from a freshly-read current figure inside the same
 * transaction it posts into is therefore idempotent. A second submit of the same
 * target reads the first's committed adjustment and computes a zero delta.
 */
const readProjectedFigureTx = async (
  tx: TxScope,
  subquery: SqlStatement,
): Promise<number> => {
  const rows = resultRows<{ figure: number | bigint }>(
    await tx.execute(sql`SELECT ${subquery} AS figure`),
  );
  return Number(rows[0]!.figure);
};

/** A figure read by turning one id into its subquery. */
const figureBySubqueryTx =
  (subquery: (id: string) => SqlStatement) =>
  (tx: TxScope, id: number): Promise<number> =>
    readProjectedFigureTx(tx, subquery(String(id)));

/** What an attendee currently owes (−balanceOf(attendee)) read in-transaction. */
export const attendeeOwedTx = figureBySubqueryTx(attendeeOwedSubquery);

/** A listing's currently projected income (gross credits less write-off debits)
 *  read in-transaction — the figure {@link adjustListingIncome} corrects. */
export const listingIncomeTx = figureBySubqueryTx((id) =>
  creditsLessWriteoffDebits(REVENUE, id),
);

/** A modifier's currently projected net revenue (balanceOf(modifier)) read
 *  in-transaction — the figure {@link adjustModifierRevenue} corrects. */
export const modifierRevenueTx = figureBySubqueryTx((id) =>
  accountBalanceSubquery(MODIFIER, id),
);
