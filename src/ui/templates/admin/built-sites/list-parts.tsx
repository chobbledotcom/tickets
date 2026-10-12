/* jscpd:ignore-start */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import type { Child, SafeHtml } from "#jsx/jsx-runtime.ts";
import type { BuiltSitesSort } from "#shared/built-sites-list.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { formatDeadlineLabel } from "#shared/renewal-helpers.ts";
import { siteBaseUrl } from "#shared/site-address.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";
import {
  ActionButton,
  guideFooterFor,
} from "#templates/components/actions.tsx";
import { linkCell } from "#templates/components/link-cell.tsx";
import { NewTabUrl } from "#templates/components/new-tab-link.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** The "read more" footer link shared by the built-sites list and builder pages. */
export const BuiltSitesGuideFooter = (): SafeHtml =>
  guideFooterFor("/admin/guide#built-sites", "built_sites.guide_link");

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
  <NewTabUrl url={siteBaseUrl(site.siteUrl)} />
);

/** The heading of one sortable column: a link to that sort, or plain bold
 *  text when the list already shows it. */
const sortableHeader = (
  current: BuiltSitesSort,
  sortOrder: BuiltSitesSort,
  labelKey: string,
): Child =>
  sortOrder === current ? (
    <strong>{t(labelKey)}</strong>
  ) : (
    <a href={`/admin/built-sites?sort=${sortOrder}`}>{t(labelKey)}</a>
  );

const sortableColumn = (
  key: "name" | "created" | "read_only",
  current: BuiltSitesSort,
  sortOrder: BuiltSitesSort,
  labelKey: string,
  cell: TableColumn<BuiltSite>["cell"],
) => ({
  cell,
  header: () => sortableHeader(current, sortOrder, labelKey),
  key,
});

const builtSiteColumns = (
  current: BuiltSitesSort,
): readonly TableColumn<BuiltSite>[] => [
  sortableColumn("name", current, "name", "common.name", builtSiteNameCell),
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
  sortableColumn("created", current, "created", "common.created", (site) =>
    formatDatetimeShort(site.created),
  ),
  sortableColumn(
    "read_only",
    current,
    "read_only_from",
    "built_sites.table_read_only",
    (site) => formatDeadlineLabel(site.readOnlyFrom),
  ),
];

const builtSitesTable = (current: BuiltSitesSort) =>
  defineTable(builtSiteColumns(current));

/** The sites the list shows, their shared host marker, and the order its
 *  header links name. */
interface BuiltSitesListProps {
  hostingIds: string;
  sites: BuiltSite[];
  sort: BuiltSitesSort;
}

const BuiltSitesTable = ({
  hostingIds,
  sites,
  sort: sortOrder,
}: BuiltSitesListProps): JSX.Element => (
  <div>
    {renderTable(builtSitesTable(sortOrder), sites)}
    <p>{hostingIds}</p>
  </div>
);

export const BuiltSitesListBody = ({
  hostingIds,
  renewalTiers,
  sites,
  sort: sortOrder,
}: BuiltSitesListProps & { renewalTiers: ListingWithCount[] }): JSX.Element => (
  <>
    <p>{t("built_sites.list_count", { count: sites.length })}</p>
    {sites.length === 0 ? (
      <p>{t("built_sites.no_built_sites")}</p>
    ) : (
      <BuiltSitesTable hostingIds={hostingIds} sites={sites} sort={sortOrder} />
    )}
    <RenewalTierSummary tiers={renewalTiers} />
  </>
);
