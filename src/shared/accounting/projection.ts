import { costAccount, revenueAccount } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";

/** Positive total of posted servicing costs for one listing. */
export const costOf = async (listingId: number): Promise<number> => {
  const cost = -(await accountBalance(costAccount(listingId)));
  return Object.is(cost, -0) ? 0 : cost;
};

/** Gross listing income less servicing costs. */
export const profitOf = async (listingId: number): Promise<number> =>
  (await accountBalance(revenueAccount(listingId))) - (await costOf(listingId));
