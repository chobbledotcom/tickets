/** The owner-only tabbed page for one built site. Expensive provider and
 * database checks belong to their own tabs, so ordinary edits do not run them. */

/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
  panelTab,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { builtSitesCrudTable } from "#shared/db/built-sites.ts";
import { loadSiteSecretsStatus } from "#shared/site-secrets.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
import {
  MaintenancePanel,
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { BuiltSiteEditPanel } from "#templates/admin/built-sites.tsx";

/* jscpd:ignore-end */

const basePath = (id: number): string => adminPath("builtSite", { id });

const renewalTab = panelTab<BuiltSite>(
  "renewal",
  "built_sites.renewal_title",
  (site) => Promise.resolve(renewalPanelFor(site)),
);

const secretsTab = panelTab<BuiltSite>(
  "secrets",
  "built_sites.secrets_title",
  async (site) => (
    <SecretsPanel site={site} view={await loadSiteSecretsStatus(site)} />
  ),
);

const updateTab = panelTab<BuiltSite>(
  "update",
  "built_sites.update_title",
  async (site) => (
    <UpdatePanel site={site} state={await loadBuiltSiteUpdateState(site)} />
  ),
);

const maintenanceTab = panelTab<BuiltSite>(
  "maintenance",
  "built_sites.maintenance_title",
  async (site) => (
    <MaintenancePanel
      monitor={await uptimeKumaMonitorService.load(site)}
      site={site}
    />
  ),
);

export const builtSitePage: EditEntityPage<BuiltSite> = defineEditEntityPage({
  basePath,
  deleteLabelKey: "built_sites.delete_this_site",
  edit: (site, _ctx, rejected) =>
    Promise.resolve(
      <BuiltSiteEditPanel site={site} {...submittedValueProps(rejected)} />,
    ),
  extraTabs: [renewalTab, maintenanceTab, secretsTab, updateTab],
  guard: requireOwnerOr,
  guideFooter: () => Promise.resolve(<BuiltSitesGuideFooter />),
  load: (id) => builtSitesCrudTable.read.one({ id }),
  navActive: adminPattern("builtSites"),
});
