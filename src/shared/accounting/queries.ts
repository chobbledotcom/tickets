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
} from "#accounting/accounts.ts";
import {
  figureOf,
  listingIncomeSubquery,
  owedBy,
  recognisedIncomeOf,
} from "#accounting/figures.ts";
import { KIND } from "#accounting/kinds.ts";
import { readMeasures } from "#accounting/measure-reads.ts";
import {
  accountBalanceSubquery,
  accountsAmong,
  amountOf,
  attendeeOwedSubquery,
  balanceIn,
  everyAccountOf,
  type Leg,
  ledgerLegs,
  modifierLeg,
  ofKind,
  oneAccount,
  touching,
} from "#accounting/projection-sql.ts";
import {
  LEDGER_ROW,
  type LedgerRange,
  occurredAtRange,
} from "#accounting/range.ts";
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
  type Condition,
  desc,
  type Expr,
  literal,
  or,
  valued,
  wholeCondition,
} from "#db/select/expression.ts";
import { type SqlStatement, sql, sqlLiteral } from "#db/sql.ts";
import { groupToMap, requiredMapValue, unique, uniqueBy } from "#fp";
import { accountKey } from "#shared/ledger/account.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";

/** Newest first by business time, ties broken by id so the order is stable. */
const newestFirst = (leg: Leg): SqlStatement[] => [
  desc(leg.occurredAt),
  desc(leg.id),
];

/** The newest legs that pass the conditions, capped at `limit`. The order and
 *  the limit run in SQL, so the whole ledger is never loaded. */
const newestTransfers = (
  limit: number,
  conditions: (leg: Leg) => readonly Condition[],
): Promise<Transfer[]> =>
  selectTransfers(queryBatch, (ledger) =>
    ledger.where(conditions).orderBy(newestFirst).limit(limit),
  );

/** The WHERE scope for "every transfer touching any of these accounts".
 *  One group per account type. */
const accountsScope = (accounts: readonly AccountRef[]): SqlStatement =>
  or(
    ...[...Map.groupBy(accounts, ({ type }) => type)].flatMap(
      ([type, sameType]) =>
        touching(
          accountsAmong(
            type,
            sameType.map(({ id }) => id),
          ),
        )(LEDGER_ROW),
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
  requiredMapValue(await transfersByAccounts([account]), accountKey(account));

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
      .where((leg) => [modifierLeg.filter(leg), among(leg.eventGroup, groups)])
      .groupBy((leg) => [leg.eventGroup, modifierId(leg)])
      .orderBy((leg) => [leg.eventGroup, modifierId(leg)])
      .select((leg) => ({
        amount: modifierLeg.signedAmount(leg),
        event_group: leg.eventGroup,
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

/** Legs shown on the operator-facing ledger list. Routine checkout cash
 * plumbing ("Card / bank → <attendee>" and its refund mirror) stays hidden.
 * Owner-entered manual rows and service cost legs remain visible even when they
 * record an external cost. */
const VISIBLE_TRANSFER_SCOPE = wholeCondition(
  sql`(source_type != ${sqlLiteral(EXTERNAL)} AND dest_type != ${sqlLiteral(EXTERNAL)} OR kind LIKE 'manual\\_%' ESCAPE '\\' OR kind = ${sqlLiteral(KIND.serviceCost)})`,
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
      touching(accountsAmong(literal(REVENUE), ids))(leg),
      touching(accountsAmong(literal(COST), ids))(leg),
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
  newestTransfers(limit, (leg) => [
    VISIBLE_TRANSFER_SCOPE,
    ...occurredAtRange(range),
    listingLegScope(listingIds)(leg),
  ]);

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

/**
 * The headline ledger figures over `range`, in one pass. Income reads the
 * same definitions as `listingMoneyTotals`, over every revenue account. Over
 * "forever", `due` is the current total outstanding.
 */
export const ledgerTotals = (range: LedgerRange): Promise<LedgerTotals> =>
  readMeasures(
    {
      due: owedBy(everyAccountOf(ATTENDEE)),
      fees: balanceIn(everyAccountOf(FEE_INCOME)),
      income: recognisedIncomeOf(everyAccountOf(REVENUE)),
      refunded: amountOf(ofKind(KIND.refundCash)),
      servicingCosts: figureOf("servicingCosts", everyAccountOf(COST)),
    },
    range,
  );

/** Balance of one account: money in as the destination, less money out as
 *  the source. Zero when the account has no transfers. */
export const accountBalance = async (acct: AccountRef): Promise<number> =>
  (await readMeasures({ balance: balanceIn(oneAccount(acct.type, acct.id)) }))
    .balance;

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
export const listingIncomeTx = figureBySubqueryTx(listingIncomeSubquery);

/** A modifier's currently projected net revenue (balanceOf(modifier)) read
 *  in-transaction — the figure {@link adjustModifierRevenue} corrects. */
export const modifierRevenueTx = figureBySubqueryTx((id) =>
  accountBalanceSubquery(MODIFIER, id),
);
