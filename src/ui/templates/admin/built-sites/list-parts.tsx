/* jscpd:ignore-start */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import {
  formatDeadlineLabel,
  siteRenewalTier,
} from "#shared/renewal-helpers.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import { NewTabUrl } from "#templates/components/new-tab-link.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** The "read more" footer link shared by the built-sites list and builder pages. */
export const BuiltSitesGuideFooter = (): JSX.Element => (
  <GuideFooter href="/admin/guide#built-sites">
    {t("built_sites.guide_link")}
  </GuideFooter>
);

export const BuiltSitesListActions = (): JSX.Element | null =>
  WritableOnly({
    children: (
      <>
        <ActionButton href="/admin/built-sites/new" icon="plus">
          {t("built_sites.add_built_site")}
        </ActionButton>
        <ActionButton href="/admin/builder" icon="hammer" variant="secondary">
          {t("built_sites.build_new_site")}
        </ActionButton>
      </>
    ),
  });

const builtSiteNameCell = (site: BuiltSite): JSX.Element => (
  <a href={`/admin/built-sites/${site.id}`}>{site.name}</a>
);

const builtSiteUrlCell = (site: BuiltSite): JSX.Element => (
  <NewTabUrl url={site.siteUrl} />
);

/** The tier column reads the same qualifying list the page already loaded for
 * its summary table, so a site's tier is named the same way in both. */
const builtSiteTierCell = (
  site: BuiltSite,
  tiers: ListingWithCount[],
): JSX.Element | string => {
  const chosen = siteRenewalTier(site, tiers);
  if (chosen.kind === "pinned") {
    return <a href={`/admin/listing/${chosen.tier.id}`}>{chosen.tier.name}</a>;
  }
  return t(
    chosen.kind === "retired"
      ? "built_sites.tier_cell_removed"
      : "built_sites.tier_cell_any",
  );
};

/** Every column reads the page's qualifying tiers as its context. */
type BuiltSiteColumn = TableColumn<BuiltSite, ListingWithCount[]>;

const builtSiteColumns: readonly BuiltSiteColumn[] = [
  translatedTableColumn("name", "common.name", builtSiteNameCell),
  translatedTableColumn(
    "site_url",
    "built_sites.table_site_url",
    builtSiteUrlCell,
  ),
  translatedTableColumn("status", "common.status", (site) =>
    site.assignedAttendeeId
      ? t("built_sites.status_assigned", { id: site.assignedAttendeeId })
      : site.assignable
        ? t("built_sites.status_available")
        : t("built_sites.status_not_assignable"),
  ),
  translatedTableColumn(
    "renewal_tier",
    "built_sites.table_renewal_tier",
    builtSiteTierCell,
  ),
  translatedTableColumn(
    "updates",
    "built_sites.table_updates",
    (site) => site.updates,
  ),
  translatedTableColumn("read_only", "built_sites.table_read_only", (site) =>
    formatDeadlineLabel(site.readOnlyFrom),
  ),
];

const builtSitesTable = defineTable(builtSiteColumns);

type BuiltSitesListProps = {
  hostingIds: string;
  renewalTiers: ListingWithCount[];
  sites: BuiltSite[];
};

export const BuiltSitesListBody = ({
  hostingIds,
  renewalTiers,
  sites,
}: BuiltSitesListProps): JSX.Element => (
  <>
    {sites.length === 0 ? (
      <p>{t("built_sites.no_built_sites")}</p>
    ) : (
      <div>
        {renderTable(builtSitesTable, sites, { context: renewalTiers })}
        <p>{hostingIds}</p>
      </div>
    )}
    <RenewalTierSummary tiers={renewalTiers} />
  </>
);
