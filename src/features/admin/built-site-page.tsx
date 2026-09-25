/** The owner-only tabbed page for one built site. Expensive provider and
 * database checks belong to their own tabs, so ordinary edits do not run them. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites, builtSitesCrudTable } from "#db/built-sites.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import {
  defineEditEntityPage,
  type EditEntityPage,
  panelTab,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import {
  type FlankingNav,
  wrapAroundNeighbours,
} from "#shared/entity-pages/core.ts";
import { loadSiteSecretsStatus } from "#shared/site-secrets.ts";
import { loadSiteSupportMessage } from "#shared/site-support-message.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
import {
  MaintenancePanel,
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { SupportMessagePanel } from "#templates/admin/built-sites/support-message.tsx";
import { BuiltSiteEditPanel } from "#templates/admin/built-sites.tsx";
import { Icon, type IconName } from "#templates/components/actions.tsx";

/* jscpd:ignore-end */

const renewalTab = panelTab<BuiltSite>(
  "renewal",
  "built_sites.renewal_title",
  (site) => Promise.resolve(renewalPanelFor(site)),
);

/** A tab whose panel loads its own data: the read-then-render shape the
 * Secrets, Update, Maintenance, and Support message tabs share. */
const loadedPanelTab = <Data,>(
  slug: string,
  labelKey: string,
  load: (site: BuiltSite) => Promise<Data>,
  render: (site: BuiltSite, data: Data) => JSX.Element,
) =>
  panelTab<BuiltSite>(slug, labelKey, async (site) =>
    render(site, await load(site)),
  );

const secretsTab = loadedPanelTab(
  "secrets",
  "built_sites.secrets_title",
  loadSiteSecretsStatus,
  (site, view) => <SecretsPanel site={site} view={view} />,
);

const updateTab = loadedPanelTab(
  "update",
  "built_sites.update_title",
  loadBuiltSiteUpdateState,
  (site, state) => <UpdatePanel site={site} state={state} />,
);

const maintenanceTab = loadedPanelTab(
  "maintenance",
  "built_sites.maintenance_title",
  (site) => uptimeKumaMonitorService.load(site),
  (site, monitor) => <MaintenancePanel monitor={monitor} site={site} />,
);

const supportMessageTab = loadedPanelTab(
  "support-message",
  "built_sites.support_message_title",
  loadSiteSupportMessage,
  (site, message) => <SupportMessagePanel site={site} state={message} />,
);

/** One pager arrow, named for the site it lands on. */
const BuiltSitePagerLink = ({
  icon,
  labelKey,
  site,
  slug,
}: {
  icon: IconName;
  labelKey: "built_sites.pager_previous" | "built_sites.pager_next";
  site: BuiltSite;
  slug: string;
}): JSX.Element => (
  <a
    aria-label={t(labelKey)}
    href={builtSitePage.path(site.id, slug)}
    title={site.name}
  >
    <Icon name={icon} />
  </a>
);

/** One pager arrow for the site it lands on. Null when no neighbouring site
 * sits on that side — the list holds only this site. */
const pagerArrow = (
  neighbour: BuiltSite | null,
  icon: IconName,
  labelKey: "built_sites.pager_previous" | "built_sites.pager_next",
  ctx: PageCtx,
): JSX.Element | null =>
  neighbour === null ? null : (
    <BuiltSitePagerLink
      icon={icon}
      labelKey={labelKey}
      site={neighbour}
      slug={ctx.activeTabSlug}
    />
  );

/** The ← site name → arrows over the built-sites list, wrap-around so the
 * owner can cycle every site without falling off the end. Each arrow keeps
 * the current tab, so checking every site's Support message stays at one
 * click per site.
 */
const builtSitePagerNav = async (
  site: BuiltSite,
  ctx: PageCtx,
): Promise<FlankingNav> => {
  const neighbours = wrapAroundNeighbours(
    await builtSites.getAll(),
    (listed: BuiltSite) => listed.id === site.id,
  );
  return {
    after: pagerArrow(
      neighbours.next,
      "arrow-right",
      "built_sites.pager_next",
      ctx,
    ),
    before: pagerArrow(
      neighbours.previous,
      "arrow-left",
      "built_sites.pager_previous",
      ctx,
    ),
  };
};

export const builtSitePage: EditEntityPage<BuiltSite> = defineEditEntityPage({
  deleteLabelKey: "built_sites.delete_this_site",
  destination: "builtSite",
  edit: (site, _ctx, rejected) =>
    Promise.resolve(
      <BuiltSiteEditPanel site={site} {...submittedValueProps(rejected)} />,
    ),
  extraTabs: [
    renewalTab,
    maintenanceTab,
    secretsTab,
    updateTab,
    supportMessageTab,
  ],
  guideFooter: () => Promise.resolve(<BuiltSitesGuideFooter />),
  load: (id) => builtSitesCrudTable.read.one({ id }),
  navActive: adminPattern("builtSites"),
  titleNav: builtSitePagerNav,
});
