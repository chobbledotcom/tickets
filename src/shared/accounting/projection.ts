import { costAccount } from "#shared/accounting/accounts.ts";
import { creditsLessWriteoffDebits } from "#shared/accounting/projection-sql.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { queryOne } from "#shared/db/client.ts";

/** Positive total of posted servicing costs for one listing. */
export const costOf = async (listingId: number): Promise<number> => {
  const cost = -(await accountBalance(costAccount(listingId)));
  return Object.is(cost, -0) ? 0 : cost;
};

/**
 * Recognised (gross) income for one listing: `sale` credits to its revenue
 * account plus manual write-ups, less manual write-downs — the same
 * refund-agnostic figure {@link listingProfitSubquery} /
 * {@link listingRevenueBreakdown}.recognisedIncome read. A `refund_sale` leg
 * lowers the net revenue *balance* but not recognised income, so a refund does
 * not change this figure (matching the legacy `SUM(price_paid)` admins saw).
 */
export const recognisedIncomeOf = async (
  listingId: number,
): Promise<number> => {
  const row = await queryOne<{ income: number | bigint }>(
    `SELECT ${creditsLessWriteoffDebits("revenue", String(listingId))} AS income`,
  );
  return Number(row!.income);
};

/**
 * Listing profit = recognised (gross) income − servicing costs. Mirrors the SQL
 * {@link listingProfitSubquery} exactly, so the figure shown on the listing row
 * and the pure projection never diverge — in particular, an ordinary refund
 * lowers the net revenue balance (`accountBalance(revenue)`) but NOT
 * recognised income, so it must not flow into profit through the projection.
 */
export const profitOf = async (listingId: number): Promise<number> =>
  (await recognisedIncomeOf(listingId)) - (await costOf(listingId));
