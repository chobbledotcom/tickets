import { compact } from "#fp";
import { t } from "#i18n";
import type { ListingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  MoneySummary,
  type MoneySummaryRow,
} from "#templates/admin/money-summary.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";

const whenNonZero = (
  value: number,
  row: (value: number) => MoneySummaryRow,
): MoneySummaryRow | null => (value === 0 ? null : row(value));

const incomeBreakdownRows = (
  breakdown: ListingMoneyTotals,
  listing: ListingWithCount,
): MoneySummaryRow[] =>
  compact([
    {
      amount: breakdown.grossSales,
      label: t("listings_table.income_ledger_gross_sales"),
    },
    whenNonZero(breakdown.externalIncome, (amount) => ({
      amount,
      label: t("listings_table.income_ledger_external_income"),
    })),
    whenNonZero(breakdown.manualAdjustments, (amount) => ({
      amount,
      label: t("listings_table.income_ledger_manual_adjustments"),
    })),
    {
      amount: breakdown.recognisedIncome,
      label: t("listings_table.income_ledger_recognised_income"),
      signed: false,
      subtotal: true,
    },
    {
      amount: -listing.cost,
      label: t("listings_table.income_ledger_costs"),
    },
    {
      amount: listing.profit,
      label: t("listings_table.income_ledger_profit"),
      signed: false,
      subtotal: true,
    },
    {
      amount: -breakdown.refunds,
      label: t("listings_table.income_ledger_refunds"),
    },
    whenNonZero(breakdown.externalCosts, (amount) => ({
      amount: -amount,
      label: t("listings_table.income_ledger_external_costs"),
    })),
    {
      amount: breakdown.netBalance - listing.cost,
      label: t("listings_table.income_ledger_net_balance"),
      signed: false,
      subtotal: true,
    },
  ]);

export const ListingIncomeLedgerSection = ({
  breakdown,
  ledgerHref,
  listing,
}: {
  breakdown: ListingMoneyTotals;
  ledgerHref?: string | undefined;
  listing: ListingWithCount;
}): JSX.Element => (
  <PageBlock as="article" id="income-ledger">
    <MoneySummary
      ledgerHref={ledgerHref}
      ledgerLabel={t("listings_table.income_ledger_view_full")}
      note={t("listings_table.income_ledger_recognised_note")}
      rows={incomeBreakdownRows(breakdown, listing)}
      title={t("listings_table.income_ledger_legend")}
    />
  </PageBlock>
);
