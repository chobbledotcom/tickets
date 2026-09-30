import { mapValues } from "@std/collections";
import { t } from "#i18n";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes, type RouteHandlerFn } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";

/**
 * Admin built site management routes - owner only
 */

import { logActivity } from "#db/activity-log.ts";
import { dbName, hasRecentBackup } from "#db/backup-storage.ts";
import {
  type BuiltSite,
  type BuiltSiteFormInput,
  isUpdateTier,
  providerOrBunny,
} from "#db/built-sites/types.ts";
import { builtSites, builtSitesCrudTable } from "#db/built-sites.ts";
/* jscpd:ignore-start */
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { ownerPage } from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";
import { isBuilderEnabled } from "#shared/config.ts";
/* jscpd:ignore-end */
import { getFlash } from "#shared/flash-context.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { isProvisioned, isReservedRenewal } from "#shared/renewal-helpers.ts";
import { getQualifyingTierListings } from "#shared/renewal-tier.ts";
import { defineResource } from "#shared/rest/resource.ts";
/* jscpd:ignore-end */
import { siteHostingAccess } from "#shared/site-hosting.ts";
import { rotateRenewalToken } from "#shared/site-renewal.ts";
import { provisionSiteScheduler } from "#shared/site-scheduler.ts";
import { addMissingSiteSecrets } from "#shared/site-secrets.ts";
import { deployAndReport } from "#shared/site-update.ts";
import {
  deployLatestReleaseToDeno,
  deployLatestReleaseToScript,
} from "#shared/update.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { getBuiltSiteForm } from "#templates/fields/admin.ts";
import {
  builtSiteAction,
  builtSiteTabError,
  builtSiteTabResult,
  builtSiteTabSuccess,
} from "./built-site-action.ts";
import { builtSitePage } from "./built-site-page.tsx";
import {
  editPushOk,
  handleBumpDeadline,
  handleOverrideDeadline,
  handleProvisionRenewal,
  handleReSyncDeadline,
} from "./built-site-renewal-actions.ts";
import { handleSaveSiteSupportMessage } from "./built-site-support-message.ts";

/** Extract built site input from validated form values.
 *
 * `updates` is carried only when the form submitted a recognised channel, so an
 * edit that omits the field (a stale form, or an automation posting the older
 * field set) leaves the stored channel untouched rather than silently resetting
 * it. On create, the table layer applies DEFAULT_UPDATE_TIER for the absent key. */
type BuiltSiteFormValues = FormValues<ReturnType<typeof getBuiltSiteForm>>;

const extractBuiltSiteInput = (
  values: BuiltSiteFormValues,
): BuiltSiteFormInput => {
  // validateForm always sets the select's value (a string, "" when omitted), so
  // no nullish fallback is needed — a non-tier string just isn't carried below.
  const updates = values.updates;
  const hostingProvider = providerOrBunny(values.hosting_provider, "deno");
  const dbProvider = providerOrBunny(values.db_provider, "turso");
  return {
    assignable: values.assignable === "1",
    dbProvider,
    dbToken: values.db_token,
    dbUrl: values.db_url,
    hostingId: values.hosting_id,
    hostingProvider,
    name: values.name,
    siteUrl: values.site_url,
    ...(updates !== null && isUpdateTier(updates) ? { updates } : {}),
  };
};

/** Built sites resource for REST create/update operations */
const builtSitesResource = defineResource({
  form: getBuiltSiteForm(),
  table: builtSitesCrudTable,
  toInput: extractBuiltSiteInput,
});

const crud = createCrudHandlers({
  getAll: builtSites.getAll,
  getName: (s) => s.name,
  getRowPath: (site) => builtSitePage.path(site.id),
  list: "builtSites",
  operations: builtSitesResource,
  renderDelete: adminBuiltSiteDeletePage,
  renderEditError: builtSitePage.renderEditError,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  singular: "Built site",
});

const handleProvisionSiteScheduler = builtSiteAction(async (_site, _form, id) =>
  builtSiteTabResult("maintenance")(t("built_sites.maintenance_provisioned"))(
    id,
    await provisionSiteScheduler(id),
  ),
);

const handleAddUptimeMonitor = builtSiteAction(async (site, _form, id) => {
  const result = await uptimeKumaMonitorService.add(site);
  if (!result.ok) {
    return builtSiteTabError(id, "maintenance", result.error);
  }
  if (result.value.created) {
    await logActivity(`Added Uptime Kuma monitor for '${site.name}'`);
  }
  return builtSiteTabSuccess(
    id,
    "maintenance",
    t(
      result.value.created
        ? "built_sites.kuma_added"
        : "built_sites.kuma_already_exists",
    ),
  );
});

type EditResult = Awaited<ReturnType<typeof builtSiteTabError>>;

const runSiteUpdate = async (
  site: BuiltSite,
  id: number,
  deploy: () => Promise<{ tagName: string; name: string }>,
): Promise<EditResult> => {
  if (!(await hasRecentBackup(undefined, dbName(site.dbUrl)))) {
    return builtSiteTabError(
      id,
      "update",
      "No backup of this site in the last hour — back it up before updating.",
    );
  }
  return deployAndReport({
    deploy,
    logPrefix: `Updated built site '${site.name}'`,
    onError: (message) => builtSiteTabError(id, "update", message),
    onSuccess: (message) => builtSiteTabSuccess(id, "update", message),
    successPrefix: `Updated '${site.name}'`,
  });
};

/** POST /admin/built-sites/:id/update — deploy the latest release to the site.
 *
 * The site migrates on its next request after deploy, so a recent backup of
 * *this site's* database (taken to our storage by the upgrade workflow) is
 * required before pushing a new version. */
const handleUpdateSite = builtSiteAction(async (site, _form, id) => {
  const access = siteHostingAccess(site, "it can't be updated");
  if (!access.ok) return builtSiteTabError(id, "update", access.error);
  return runSiteUpdate(site, id, () =>
    site.hostingProvider === "deno"
      ? deployLatestReleaseToDeno(site.hostingId)
      : deployLatestReleaseToScript(site.hostingId),
  );
});

/** POST /admin/built-sites/:id/rotate-renewal-token */
const handleRotateToken = builtSiteAction(async (site, _form, id) => {
  // Rotation runs only on a fully confirmed provisioning: an empty
  // read-only deadline marks a reserved-but-unconfirmed token, which the
  // assignment recovery may be re-pushing, and rotating then would race it.
  if (!isProvisioned(site) || isReservedRenewal(site)) {
    return builtSiteTabError(
      id,
      "renewal",
      "Renewal is not provisioned for this site",
    );
  }
  const pushed = await rotateRenewalToken(
    site,
    `Rotate token push failed for site ${id}`,
  );
  if (pushed) {
    await logActivity(`Rotated renewal token for '${site.name}'`);
  }
  return editPushOk(
    id,
    pushed,
    "Renewal token rotated",
    "Renewal token could not be pushed to the site",
  );
});

/** POST /admin/built-sites/:id/add-secrets
 *
 * Backfills the secrets we copy to freshly built sites onto an existing site.
 * Re-verifies the live secrets first, then sets only the ones still missing —
 * an existing secret is never overwritten (it may have been changed for a
 * reason). */
const handleAddSecrets = builtSiteAction(async (site, _form, id) => {
  const result = await addMissingSiteSecrets(site);
  if (!result.ok) {
    return builtSiteTabError(
      id,
      "secrets",
      `Secrets could not be set: ${result.error}`,
    );
  }
  if (result.added.length === 0) {
    return builtSiteTabSuccess(
      id,
      "secrets",
      "No missing secrets — nothing to set",
    );
  }
  const summary = `${result.added.length} missing secret(s): ${result.added.join(
    ", ",
  )}`;
  await logActivity(`Set ${summary} on '${site.name}'`);
  return builtSiteTabSuccess(id, "secrets", `Set ${summary}`);
});

/** GET /admin/built-sites — overrides the CRUD list so we can render the
 * renewal-tier summary alongside the sites table. */
const handleBuiltSitesListGet = ownerPage(async (session) => {
  const [sites, tiers] = await Promise.all([
    builtSites.getAll(),
    getQualifyingTierListings(),
  ]);
  return adminBuiltSitesPage(sites, session, getFlash().success, tiers);
});

/** The whole built-sites section is hidden from the nav when CAN_BUILD_SITES is
 * off, so its routes must not be reachable either — we never serve a page for a
 * disabled feature. Wrapping the route map keeps that gate in one place instead
 * of a repeated check at the top of every handler. */
const builderOnly =
  (handler: RouteHandlerFn): RouteHandlerFn =>
  (request, params) =>
    isBuilderEnabled() ? handler(request, params) : notFoundResponse();

const gateOnBuilder = <Key extends string>(
  routes: Record<Key, (...args: never[]) => unknown>,
): Record<Key, RouteHandlerFn> =>
  mapValues(routes, (handler) => builderOnly(handler as RouteHandlerFn));

/** Built site routes (all gated on CAN_BUILD_SITES via gateOnBuilder). The
 * list GET restates the standard key with its own handler. */
export const adminHandlers = gateOnBuilder(
  defineRoutes({
    ...crudRoutes(adminPattern("builtSites"), crud),
    ...entityTabRoutes(adminPattern("builtSite"), builtSitePage),
    "GET /admin/built-sites": handleBuiltSitesListGet,
    "POST /admin/built-sites/:id/add-secrets": handleAddSecrets,
    "POST /admin/built-sites/:id/add-uptime-monitor": handleAddUptimeMonitor,
    "POST /admin/built-sites/:id/bump-deadline": handleBumpDeadline,
    "POST /admin/built-sites/:id/override-deadline": handleOverrideDeadline,
    "POST /admin/built-sites/:id/provision-renewal": handleProvisionRenewal,
    "POST /admin/built-sites/:id/provision-scheduler":
      handleProvisionSiteScheduler,
    "POST /admin/built-sites/:id/re-sync-deadline": handleReSyncDeadline,
    "POST /admin/built-sites/:id/rotate-renewal-token": handleRotateToken,
    "POST /admin/built-sites/:id/support-message": handleSaveSiteSupportMessage,
    "POST /admin/built-sites/:id/update": handleUpdateSite,
  }),
);
