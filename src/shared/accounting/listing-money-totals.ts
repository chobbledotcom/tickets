import { COST, REVENUE } from "#accounting/accounts.ts";
import {
  figureOf,
  incomeParts,
  recognisedIncomeOf,
} from "#accounting/figures.ts";
import { readMeasures } from "#accounting/measure-reads.ts";
import {
  accountsAmong,
  balanceIn,
  countOf,
  some,
  touching,
} from "#accounting/projection-sql.ts";
import type { LedgerRange } from "#accounting/range.ts";
import { literal } from "#db/select/expression.ts";

export type ListingMoneyTotals = {
  externalCosts: number;
  externalIncome: number;
  grossSales: number;
  manualAdjustments: number;
  netBalance: number;
  recognisedIncome: number;
  refunds: number;
  servicingCosts: number;
  transferCount: number;
};

/** The full money breakdown for one-or-many listings inside a range, in one
 * pass over the ledger. Revenue account movements and service-event cost
 * account movements stay separate: `netBalance` is only the selected revenue
 * accounts' balance, while callers that report profit subtract
 * `servicingCosts` themselves. */
export const listingMoneyTotals = (
  range: LedgerRange,
  listingIds: readonly number[],
): Promise<ListingMoneyTotals> => {
  const ids = listingIds.map(String);
  const revenue = accountsAmong(literal(REVENUE), ids);
  const cost = accountsAmong(literal(COST), ids);
  return readMeasures(
    {
      ...incomeParts(revenue),
      externalCosts: figureOf("externalCosts", revenue),
      netBalance: balanceIn(revenue),
      recognisedIncome: recognisedIncomeOf(revenue),
      refunds: figureOf("refunds", revenue),
      servicingCosts: figureOf("servicingCosts", cost),
      transferCount: countOf(some(touching(revenue), touching(cost))),
    },
    range,
  );
};
