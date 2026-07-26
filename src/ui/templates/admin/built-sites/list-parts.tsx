import { t } from "#i18n";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { formatDeadlineLabel } from "#shared/renewal-helpers.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import { NewTabUrl } from "#templates/components/new-tab-link.tsx";
import { renderTable } from "#templates/components/table.tsx";

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

const builtSiteColumns: readonly TableColumn<BuiltSite>[] = [
  {
    cell: builtSiteNameCell,
    header: t("common.name"),
    key: "name",
  },
  {
    cell: builtSiteUrlCell,
    header: t("built_sites.table_site_url"),
    key: "site_url",
  },
  {
    cell: (site) =>
      site.assignedAttendeeId
        ? t("built_sites.status_assigned", { id: site.assignedAttendeeId })
        : site.assignable
          ? t("built_sites.status_available")
          : t("built_sites.status_not_assignable"),
    header: t("common.status"),
    key: "status",
  },
  {
    cell: (site) => site.updates,
    header: t("built_sites.table_updates"),
    key: "updates",
  },
  {
    cell: (site) => formatDeadlineLabel(site.readOnlyFrom),
    header: t("built_sites.table_read_only"),
    key: "read_only",
  },
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
