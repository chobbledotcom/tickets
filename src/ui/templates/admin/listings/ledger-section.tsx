import { compact } from "#fp";
import { t } from "#i18n";
import type { ListingRevenueBreakdown } from "#shared/db/listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  type AccountLedgerData,
  EmbeddedAccountStatementSection,
} from "#templates/admin/ledger/statement.tsx";
import {
  MoneySummary,
  type MoneySummaryRow,
} from "#templates/admin/money-summary.tsx";

const whenNonZero = (
  value: number,
  row: (value: number) => MoneySummaryRow,
): MoneySummaryRow | null => (value === 0 ? null : row(value));

const incomeBreakdownRows = (
  breakdown: ListingRevenueBreakdown,
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
  breakdown: ListingRevenueBreakdown;
  ledgerHref?: string | undefined;
  listing: ListingWithCount;
}): JSX.Element => (
  <article id="income-ledger">
    <MoneySummary
      ledgerHref={ledgerHref}
      ledgerLabel={t("listings_table.income_ledger_view_full")}
      note={t("listings_table.income_ledger_recognised_note")}
      rows={incomeBreakdownRows(breakdown, listing)}
      title={t("listings_table.income_ledger_legend")}
    />
  </article>
);

export const ListingLedgerSection = ({
  ledger,
  listingId,
}: {
  ledger: AccountLedgerData;
  listingId: number;
}): JSX.Element => (
  <EmbeddedAccountStatementSection
    fullLedgerHref={`/admin/ledger/${ledger.account.type}/${ledger.account.id}`}
    id="ledger"
    ledger={ledger}
    returnUrl={`/admin/listing/${listingId}`}
  />
);
