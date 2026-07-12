import { COST, REVENUE, WRITEOFF_TYPE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#shared/accounting/manual-entries.ts";
import {
  andPrefixed,
  type LedgerRange,
  occurredAtRange,
} from "#shared/accounting/range.ts";
import { queryOne } from "#shared/db/client.ts";

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

type ListingMoneyTotalsRow = {
  external_costs: number | bigint;
  external_income: number | bigint;
  gross_sales: number | bigint;
  manual_adjustments: number | bigint;
  net_balance: number | bigint;
  refunds: number | bigint;
  servicing_costs: number | bigint;
  transfer_count: number | bigint;
};

/** The full money breakdown for one-or-many listings inside a range. Revenue
 * account movements and service-event cost-account movements stay separate:
 * `netBalance` is only the selected revenue accounts' balance, while callers
 * that report profit subtract `servicingCosts` themselves. The selected ids are
 * one CTE so every CASE arm and the indexed scope share the same bound set
 * without a query per listing. */
export const listingMoneyTotals = async (
  range: LedgerRange,
  listingIds: readonly number[],
): Promise<ListingMoneyTotals> => {
  if (listingIds.length === 0) {
    return {
      externalCosts: 0,
      externalIncome: 0,
      grossSales: 0,
      manualAdjustments: 0,
      netBalance: 0,
      recognisedIncome: 0,
      refunds: 0,
      servicingCosts: 0,
      transferCount: 0,
    };
  }
  const selectedIds =
    "SELECT selectedListing.id FROM selected_listing AS selectedListing";
  const revenueCredit = `transfer.dest_type = '${REVENUE}' AND transfer.dest_id IN (${selectedIds})`;
  const revenueDebit = `transfer.source_type = '${REVENUE}' AND transfer.source_id IN (${selectedIds})`;
  const costDebit = `transfer.source_type = '${COST}' AND transfer.source_id IN (${selectedIds})`;
  const costCredit = `transfer.dest_type = '${COST}' AND transfer.dest_id IN (${selectedIds})`;
  const r = occurredAtRange(range, "transfer.occurred_at");
  // An aggregate without GROUP BY always returns one row; COALESCE supplies
  // zeroes when no transfers match, so the result cannot be null.
  const row = (await queryOne<ListingMoneyTotalsRow>(
    `WITH selected_listing(id) AS (VALUES ${listingIds.map(() => "(?)").join(", ")})
     SELECT
       COUNT(*) AS transfer_count,
       COALESCE(SUM(CASE
          WHEN transfer.kind = '${KIND.sale}' AND ${revenueCredit} THEN transfer.amount
          ELSE 0 END), 0) AS gross_sales,
       COALESCE(SUM(CASE
          WHEN transfer.kind = '${MANUAL_LISTING_INCOME}' AND ${revenueCredit} THEN transfer.amount
          ELSE 0 END), 0) AS external_income,
       COALESCE(SUM(CASE
          WHEN transfer.kind = '${KIND.adjustment}' AND ${revenueCredit} AND transfer.source_type = '${WRITEOFF_TYPE}' THEN transfer.amount
          WHEN transfer.kind = '${KIND.adjustment}' AND ${revenueDebit} AND transfer.dest_type = '${WRITEOFF_TYPE}' THEN -transfer.amount
          ELSE 0 END), 0) AS manual_adjustments,
       COALESCE(SUM(CASE
          WHEN transfer.kind = '${KIND.refundSale}' AND ${revenueDebit} THEN transfer.amount
          ELSE 0 END), 0) AS refunds,
       COALESCE(SUM(CASE
         WHEN transfer.kind = '${MANUAL_LISTING_COST}' AND ${revenueDebit} THEN transfer.amount
         ELSE 0 END), 0) AS external_costs,
       COALESCE(SUM(CASE WHEN transfer.kind = '${KIND.serviceCost}' AND ${costDebit}
                         THEN transfer.amount ELSE 0 END
                  - CASE WHEN transfer.kind = '${KIND.serviceCost}' AND ${costCredit}
                         THEN transfer.amount ELSE 0 END), 0) AS servicing_costs,
       COALESCE(SUM(CASE WHEN ${revenueCredit} THEN transfer.amount ELSE 0 END
                  - CASE WHEN ${revenueDebit} THEN transfer.amount ELSE 0 END), 0) AS net_balance
      FROM transfers AS transfer
     WHERE (${revenueCredit} OR ${revenueDebit} OR ${costDebit} OR ${costCredit})${andPrefixed(
       r.clause,
     )}`,
    [...listingIds.map(String), ...r.args],
  ))!;
  const grossSales = Number(row.gross_sales);
  const externalIncome = Number(row.external_income);
  const manualAdjustments = Number(row.manual_adjustments);
  return {
    externalCosts: Number(row.external_costs),
    externalIncome,
    grossSales,
    manualAdjustments,
    netBalance: Number(row.net_balance),
    recognisedIncome: grossSales + externalIncome + manualAdjustments,
    refunds: Number(row.refunds),
    servicingCosts: Number(row.servicing_costs),
    transferCount: Number(row.transfer_count),
  };
};
