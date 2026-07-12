import { t } from "#i18n";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import { formatDeadlineLabel } from "#shared/renewal-helpers.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { RenewalTierSummary } from "#templates/admin/built-sites/renewal-summary.tsx";
import { WritableLink, WritableOnly } from "#templates/admin/writable-only.tsx";
import { ActionButton, GuideFooter } from "#templates/components/actions.tsx";
import { DataTable, namedColumns } from "#templates/components/data-table.tsx";

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

const BuiltSitesTable = ({
  hostingIds,
  sites,
}: {
  hostingIds: string;
  sites: BuiltSite[];
}): JSX.Element => (
  <div>
    <DataTable
      columns={namedColumns(
        "built_sites.table_site_url",
        "common.status",
        "built_sites.table_updates",
        "built_sites.table_read_only",
      )}
      rows={sites.map((site) => [
        <WritableLink href={`/admin/built-sites/${site.id}/edit`}>
          {site.name}
        </WritableLink>,
        <a href={site.siteUrl} rel="noopener" target="_blank">
          {site.siteUrl}
        </a>,
        site.assignedAttendeeId
          ? t("built_sites.status_assigned", { id: site.assignedAttendeeId })
          : site.assignable
            ? t("built_sites.status_available")
            : t("built_sites.status_not_assignable"),
        site.updates,
        formatDeadlineLabel(site.readOnlyFrom),
      ])}
    />
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
