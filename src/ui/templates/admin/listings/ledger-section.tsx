import { compact } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { ListingRevenueBreakdown } from "#shared/db/listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  type AccountLedgerData,
  EmbeddedAccountStatementSection,
} from "#templates/admin/ledger.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { colClass } from "#templates/components/table-columns.ts";

const signedCurrency = (value: number): string =>
  value === 0
    ? formatCurrency(0)
    : `${value < 0 ? "\u2212" : "+"}${formatCurrency(Math.abs(value))}`;

type BreakdownRowSpec = {
  label: string;
  amount: string;
  subtotal?: boolean;
};

const BreakdownRow = ({
  label,
  amount,
  subtotal = false,
}: BreakdownRowSpec): JSX.Element => (
  <tr class={subtotal ? "breakdown-subtotal" : undefined}>
    <th>{subtotal ? <strong>{label}</strong> : label}</th>
    <td class={colClass("amount")}>
      {subtotal ? <strong>{amount}</strong> : amount}
    </td>
  </tr>
);

const whenNonZero = (
  value: number,
  row: (value: number) => BreakdownRowSpec,
): BreakdownRowSpec | null => (value === 0 ? null : row(value));

const incomeBreakdownRows = (
  breakdown: ListingRevenueBreakdown,
  listing: ListingWithCount,
): BreakdownRowSpec[] =>
  compact([
    {
      amount: signedCurrency(breakdown.grossSales),
      label: t("listings_table.income_ledger_gross_sales"),
    },
    whenNonZero(breakdown.externalIncome, (amount) => ({
      amount: signedCurrency(amount),
      label: t("listings_table.income_ledger_external_income"),
    })),
    whenNonZero(breakdown.manualAdjustments, (amount) => ({
      amount: signedCurrency(amount),
      label: t("listings_table.income_ledger_manual_adjustments"),
    })),
    {
      amount: formatCurrency(breakdown.recognisedIncome),
      label: t("listings_table.income_ledger_recognised_income"),
      subtotal: true,
    },
    {
      amount: formatCurrency(listing.cost),
      label: t("listings_table.income_ledger_costs"),
    },
    {
      amount: formatCurrency(listing.profit),
      label: t("listings_table.income_ledger_profit"),
      subtotal: true,
    },
    {
      amount: signedCurrency(-breakdown.refunds),
      label: t("listings_table.income_ledger_refunds"),
    },
    whenNonZero(breakdown.externalCosts, (amount) => ({
      amount: signedCurrency(-amount),
      label: t("listings_table.income_ledger_external_costs"),
    })),
    {
      amount: formatCurrency(breakdown.netBalance),
      label: t("listings_table.income_ledger_net_balance"),
      subtotal: true,
    },
  ]);

export const ListingIncomeLedgerSection = ({
  breakdown,
  listing,
}: {
  breakdown: ListingRevenueBreakdown;
  listing: ListingWithCount;
}): JSX.Element => (
  <PageBlock id="income-ledger">
    <h3>{t("listings_table.income_ledger_legend")}</h3>
    <div class="table-scroll">
      <table class="listing-breakdown-table">
        <tbody>
          {incomeBreakdownRows(breakdown, listing).map(BreakdownRow)}
        </tbody>
      </table>
    </div>
    <p>
      <small>{t("listings_table.income_ledger_recognised_note")}</small>
    </p>
    <p class="actions">
      <ActionButton href={`/admin/ledger?listing=${listing.id}`}>
        {t("listings_table.income_ledger_view_full")}
      </ActionButton>
    </p>
  </PageBlock>
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
