/** The owner-only tabbed page for one built site. Expensive provider and
 * database checks belong to their own tabs, so ordinary edits do not run them. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSitesCrudTable } from "#db/built-sites.ts";
/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
  panelTab,
  submittedValueProps,
} from "#routes/admin/entity-write-tab.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { getQualifyingTierListings } from "#shared/site-assignment.ts";
import { loadSiteSecretsStatus } from "#shared/site-secrets.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
import {
  MaintenancePanel,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panel.tsx";
import { BuiltSiteEditPanel } from "#templates/admin/built-sites.tsx";

/* jscpd:ignore-end */

const renewalTab = panelTab<BuiltSite>(
  "renewal",
  "built_sites.renewal_title",
  async (site) => renewalPanelFor(site, await getQualifyingTierListings()),
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
  deleteLabelKey: "built_sites.delete_this_site",
  destination: "builtSite",
  edit: (site, _ctx, rejected) =>
    Promise.resolve(
      <BuiltSiteEditPanel site={site} {...submittedValueProps(rejected)} />,
    ),
  extraTabs: [renewalTab, maintenanceTab, secretsTab, updateTab],
  guideFooter: () => Promise.resolve(<BuiltSitesGuideFooter />),
  load: (id) => builtSitesCrudTable.read.one({ id }),
  navActive: adminPattern("builtSites"),
});
