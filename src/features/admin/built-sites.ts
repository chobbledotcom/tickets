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
import {
  builtSites,
  builtSitesCrudTable,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
/* jscpd:ignore-start */
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { ownerPage } from "#routes/auth.ts";
import { notFoundResponse } from "#routes/response.ts";
/* jscpd:ignore-end */
import { siteHostingAccess } from "#shared/builder.ts";
import { isBuilderEnabled } from "#shared/config.ts";
/* jscpd:ignore-end */
import { getFlash } from "#shared/flash-context.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { isProvisioned } from "#shared/renewal-helpers.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  addMonthsToRenewalDeadline,
  getQualifyingTierListings,
  pickTierListing,
  provisionSiteRenewal,
  renewalUrlFor,
  rotateRenewalToken,
  syncReadOnlyFrom,
} from "#shared/site-assignment.ts";
import { provisionSiteScheduler } from "#shared/site-scheduler.ts";
import { addMissingSiteSecrets } from "#shared/site-secrets.ts";
import { deployAndReport } from "#shared/site-update.ts";
import {
  deployLatestReleaseToDeno,
  deployLatestReleaseToScript,
} from "#shared/update.ts";
import { uptimeKumaMonitorService } from "#shared/uptime-kuma/monitors.ts";
import { isIsoDate } from "#shared/validation/date.ts";
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
const builtSitesResource = defineNamedResource({
  form: getBuiltSiteForm(),
  nameField: "name",
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

const renewalPushResult = builtSiteTabResult(
  "renewal",
  (error) => `Deadline could not be pushed to the site: ${error}`,
);

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

const editPushOk = (
  id: number,
  pushOk: boolean,
  success: string,
  failure: string,
): Response =>
  pushOk
    ? builtSiteTabSuccess(id, "renewal", success)
    : builtSiteTabError(id, "renewal", failure);

/** Max months any single bump/provision can request — guards against form tampering. */
const MAX_RENEWAL_MONTHS = 120;

const readClampedMonths = (form: {
  getString: (key: string) => string;
}): number => {
  const months = Number.parseInt(form.getString("months"), 10);
  if (!Number.isFinite(months) || months < 1) return 1;
  return Math.min(months, MAX_RENEWAL_MONTHS);
};

const parseDeadlineDate = (dateStr: string): string | null =>
  isIsoDate(dateStr) ? `${dateStr}T23:59:59Z` : null;

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
  if (!isProvisioned(site)) {
    return builtSiteTabError(
      id,
      "renewal",
      "Renewal is not provisioned for this site",
    );
  }
  const result = await rotateRenewalToken(
    site,
    `Rotate token push failed for site ${id}`,
  );
  if (result.pushOk) {
    await logActivity(`Rotated renewal token for '${site.name}'`);
  }
  return editPushOk(
    id,
    result.pushOk,
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

/** POST /admin/built-sites/:id/bump-deadline */
const handleBumpDeadline = builtSiteAction(async (site, form, id) => {
  const months = readClampedMonths(form);
  const newIso = addMonthsToRenewalDeadline(site, months);
  const result = await syncReadOnlyFrom(site, newIso);
  if (result.ok) {
    await logActivity(
      `Admin bumped '${site.name}' deadline by ${months} month(s)`,
    );
  }
  return renewalPushResult("Deadline bumped")(id, result);
});

/** POST /admin/built-sites/:id/override-deadline */
const handleOverrideDeadline = builtSiteAction(async (site, form, id) => {
  const dateStr = form.getString("date");
  if (!dateStr) {
    return builtSiteTabError(id, "renewal", "Choose a deadline date");
  }
  const cutoffIso = parseDeadlineDate(dateStr);
  if (!cutoffIso) {
    return builtSiteTabError(id, "renewal", "Choose a valid deadline date");
  }
  const result = await syncReadOnlyFrom(site, cutoffIso);
  if (result.ok) {
    await logActivity(`Admin overrode '${site.name}' deadline to ${cutoffIso}`);
  }
  return renewalPushResult("Deadline updated")(id, result);
});

/** POST /admin/built-sites/:id/re-sync-deadline */
const handleReSyncDeadline = builtSiteAction(async (site, _form, id) => {
  if (!site.readOnlyFrom) {
    return builtSiteTabError(id, "renewal", "No deadline to re-sync");
  }
  const renewalUrl =
    isProvisioned(site) && site.renewalToken
      ? renewalUrlFor(site.renewalToken)
      : undefined;
  const result = await syncReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  if (result.ok) {
    await logActivity(`Admin re-synced deadline for '${site.name}'`);
  }
  return renewalPushResult("Deadline re-synced")(id, result);
});

/** POST /admin/built-sites/:id/set-renewal-tier
 *
 * Chooses the one tier this site renews on. An empty choice clears it, which
 * puts every qualifying tier back in front of the customer. A choice that does
 * not qualify at the moment it is saved is refused rather than stored. A saved
 * tier can stop qualifying later, and `siteRenewalTier` calls that one
 * `retired`: the customer sees every tier again until an operator picks. */
const handleSetRenewalTier = builtSiteAction(async (site, form, id) => {
  const chosenId = form.getString("tier_id");
  if (chosenId === "") {
    await updateBuiltSiteRenewalState(site.id, { renewalTierListingId: null });
    await logActivity(`Admin cleared the renewal tier for '${site.name}'`);
    return builtSiteTabSuccess(
      id,
      "renewal",
      t("built_sites.renewal_tier_cleared"),
    );
  }
  const tiers = await getQualifyingTierListings();
  const tier = tiers.find((candidate) => String(candidate.id) === chosenId);
  if (!tier) {
    return builtSiteTabError(
      id,
      "renewal",
      t("built_sites.renewal_tier_unknown"),
    );
  }
  await updateBuiltSiteRenewalState(site.id, { renewalTierListingId: tier.id });
  await logActivity(`Admin set '${site.name}' to renew on '${tier.name}'`);
  return builtSiteTabSuccess(
    id,
    "renewal",
    t("built_sites.renewal_tier_set", { name: tier.name }),
  );
});

/** POST /admin/built-sites/:id/provision-renewal
 *
 * Gates on the existence of at least one qualifying renewal tier listing so an
 * admin doesn't generate a token that would dead-end at an empty /renew picker.
 * (The customer picks the actual tier at renew time.) */
const handleProvisionRenewal = builtSiteAction(async (site, form, id) => {
  if (isProvisioned(site)) {
    return builtSiteTabError(
      id,
      "renewal",
      "Renewal is already provisioned for this site",
    );
  }
  const tier = await pickTierListing();
  if (!tier) {
    return builtSiteTabError(
      id,
      "renewal",
      "Create a qualifying renewal tier listing before provisioning",
    );
  }
  const months = readClampedMonths(form);
  const result = await provisionSiteRenewal(
    site,
    months,
    `Provision push failed for site ${id}`,
  );
  if (result.pushOk) {
    await logActivity(
      `Admin provisioned renewals for '${site.name}' (${months}mo)`,
    );
  }
  return editPushOk(
    id,
    result.pushOk,
    "Renewal provisioned",
    "Renewal could not be pushed to the site",
  );
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
  (request, params, server) =>
    isBuilderEnabled() ? handler(request, params, server) : notFoundResponse();

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
    "POST /admin/built-sites/:id/set-renewal-tier": handleSetRenewalTier,
    "POST /admin/built-sites/:id/update": handleUpdateSite,
  }),
);
