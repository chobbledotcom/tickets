/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { DataTable } from "#templates/components/data-table.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
/* jscpd:ignore-end */

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
      <DataTable
        columns={[
          { header: t("built_sites.tier_table_tier") },
          { class: "quantity", header: t("built_sites.tier_table_months") },
          { class: "amount", header: t("built_sites.tier_table_price") },
          { class: "quantity", header: t("built_sites.tier_table_units") },
        ]}
        rows={tiers.map((tier) => [
          <a href={`/admin/listing/${tier.id}`}>{tier.name}</a>,
          tier.months_per_unit,
          formatCurrency(tier.unit_price),
          tier.attendee_count,
        ])}
      />
    )}
  </section>
);
