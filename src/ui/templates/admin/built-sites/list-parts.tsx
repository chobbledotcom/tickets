/* jscpd:ignore-start */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import { formatDeadlineLabel } from "#shared/renewal-helpers.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import { linkCell } from "#templates/components/link-cell.tsx";
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

const builtSiteNameCell = linkCell(
  (site: BuiltSite) => `/admin/built-sites/${site.id}`,
  (site) => site.name,
);

const builtSiteUrlCell = (site: BuiltSite): JSX.Element => (
  <NewTabUrl url={site.siteUrl} />
);

const builtSiteColumns: readonly TableColumn<BuiltSite>[] = [
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
    "updates",
    "built_sites.table_updates",
    (site) => site.updates,
  ),
  translatedTableColumn("read_only", "built_sites.table_read_only", (site) =>
    formatDeadlineLabel(site.readOnlyFrom),
  ),
];

const builtSitesTable = defineTable(builtSiteColumns);

const BuiltSitesTable = ({
  hostingIds,
  sites,
}: {
  hostingIds: string;
  sites: BuiltSite[];
}): JSX.Element => (
  <div>
    {renderTable(builtSitesTable, sites)}
    <p>{hostingIds}</p>
  </div>
);

export const BuiltSitesListBody = ({
  hostingIds,
  renewalTiers,
  sites,
}: {
  hostingIds: string;
  renewalTiers: ListingWithCount[];
  sites: BuiltSite[];
}): JSX.Element => (
  <>
    {sites.length === 0 ? (
      <p>{t("built_sites.no_built_sites")}</p>
    ) : (
      <BuiltSitesTable hostingIds={hostingIds} sites={sites} />
    )}
    <RenewalTierSummary tiers={renewalTiers} />
  </>
);
