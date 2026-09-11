/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { ErrorNote } from "#templates/components/error.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

const renewalTierColumns: readonly TableColumn<ListingWithCount>[] = [
  translatedTableColumn("tier", "built_sites.tier_table_tier", (tier) => (
    <a href={`/admin/listing/${tier.id}`}>{tier.name}</a>
  )),
  translatedTableColumn(
    "months",
    "built_sites.tier_table_months",
    (tier) => tier.months_per_unit,
    { class: "quantity" },
  ),
  translatedTableColumn(
    "price",
    "built_sites.tier_table_price",
    (tier) => formatCurrency(tier.unit_price),
    { class: "amount" },
  ),
  translatedTableColumn(
    "units",
    "built_sites.tier_table_units",
    (tier) => tier.attendee_count,
    { class: "quantity" },
  ),
];

const renewalTierTable = defineTable(renewalTierColumns);

export const RenewalTierSummary = ({
  tiers,
}: {
  tiers: ListingWithCount[];
}): JSX.Element => (
  <section>
    <h2>{t("built_sites.renewal_tiers_title")}</h2>
    {tiers.length === 0 ? (
      <ErrorNote>
        <Raw html={t("built_sites.no_renewal_tier")} />
      </ErrorNote>
    ) : (
      renderTable(renewalTierTable, tiers)
    )}
  </section>
);
