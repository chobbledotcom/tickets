/** The owner-only tabbed page for one built site. Expensive provider and
 * database checks belong to their own tabs, so ordinary edits do not run them. */

/* jscpd:ignore-start */
import {
  customSection,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { defineEditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { type BuiltSite, builtSitesCrudTable } from "#shared/db/built-sites.ts";
import { loadSiteSecretsStatus } from "#shared/site-secrets.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { BuiltSitesGuideFooter } from "#templates/admin/built-sites/list-parts.tsx";
import {
  renewalPanelFor,
  SecretsPanel,
  UpdatePanel,
} from "#templates/admin/built-sites/panels.tsx";
import { BuiltSiteEditPanel } from "#templates/admin/built-sites.tsx";

/* jscpd:ignore-end */

const basePath = (id: number): string => `/admin/built-sites/${id}`;

const statusTab = (
  slug: string,
  labelKey: string,
  load: (site: BuiltSite) => Promise<JSX.Element>,
): TabDef<BuiltSite> => ({
  labelKey,
  sections: [customSection(load)],
  slug,
});

const renewalTab = statusTab("renewal", "built_sites.renewal_title", (site) =>
  Promise.resolve(renewalPanelFor(site)),
);

const secretsTab = statusTab(
  "secrets",
  "built_sites.secrets_title",
  async (site) => (
    <SecretsPanel site={site} view={await loadSiteSecretsStatus(site)} />
  ),
);

const updateTab = statusTab(
  "update",
  "built_sites.update_title",
  async (site) => (
    <UpdatePanel site={site} state={await loadBuiltSiteUpdateState(site)} />
  ),
);

export const builtSitePage: EntityPage<BuiltSite> = defineEditEntityPage({
  basePath,
  deleteLabelKey: "built_sites.delete_this_site",
  edit: (site) => Promise.resolve(<BuiltSiteEditPanel site={site} />),
  extraTabs: [renewalTab, secretsTab, updateTab],
  guard: requireOwnerOr,
  guideFooter: () => Promise.resolve(<BuiltSitesGuideFooter />),
  load: (id) => builtSitesCrudTable.findById(id),
  navActive: "/admin/built-sites",
});
