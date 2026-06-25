/**
 * Admin built site management routes - owner only
 */

import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash, requireCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { RouteParams } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { dbName, hasRecentBackup } from "#shared/db/backup.ts";
import type { BuiltSite, BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import {
  builtSitesCrudTable,
  getAllBuiltSites,
  isUpdateTier,
} from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import { getFlash } from "#shared/flash-context.ts";
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
import {
  addMissingSiteSecrets,
  loadSiteSecretsStatus,
} from "#shared/site-secrets.ts";
import { loadBuiltSiteUpdateState } from "#shared/site-update.ts";
import { deployLatestReleaseToScript } from "#shared/update.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteEditPage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { getBuiltSiteFields } from "#templates/fields.ts";

/** Extract built site input from validated form values.
 *
 * `updates` is carried only when the form submitted a recognised channel, so an
 * edit that omits the field (a stale form, or an automation posting the older
 * field set) leaves the stored channel untouched rather than silently resetting
 * it. On create, the table layer applies DEFAULT_UPDATE_TIER for the absent key. */
const extractBuiltSiteInput = (
  values: Record<string, string | number | null>,
): BuiltSiteFormInput => {
  const updates = String(values.updates ?? "");
  return {
    assignable: values.assignable === "1",
    bunnyScriptId: String(values.bunny_script_id),
    bunnyUrl: String(values.bunny_url),
    dbToken: String(values.db_token),
    dbUrl: String(values.db_url),
    name: String(values.name),
    ...(isUpdateTier(updates) ? { updates } : {}),
  };
};

/** Built sites resource for REST create/update operations */
const builtSitesResource = defineNamedResource({
  fields: getBuiltSiteFields(),
  nameField: "name",
  table: builtSitesCrudTable,
  toInput: extractBuiltSiteInput,
});

const crud = createOwnerCrudHandlers({
  getAll: getAllBuiltSites,
  getName: (s) => s.name,
  listPath: "/admin/built-sites",
  renderDelete: adminBuiltSiteDeletePage,
  renderEdit: adminBuiltSiteEditPage,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  resource: builtSitesResource,
  singular: "Built site",
});

const editPath = (id: number): string => `/admin/built-sites/${id}/edit`;
const editSuccess = (id: number, message: string): Response =>
  redirect(editPath(id), message, true);
const editError = (id: number, message: string): Response =>
  errorRedirect(editPath(id), message);

const editPushResult = (
  id: number,
  result: { ok: true } | { ok: false; error: string },
  success: string,
): Response =>
  result.ok
    ? editSuccess(id, success)
    : editError(
        id,
        `Deadline could not be pushed to the site: ${result.error}`,
      );

const editPushOk = (
  id: number,
  pushOk: boolean,
  success: string,
  failure: string,
): Response => (pushOk ? editSuccess(id, success) : editError(id, failure));

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

type AdminForm = { getString: (key: string) => string };

type OwnerPostHandler = (
  site: BuiltSite,
  form: AdminForm,
  id: number,
) => Promise<Response>;

/** Owner-gated wrapper that also resolves `:id` → site or returns 404. */
const withOwnerAndSite = (
  request: Request,
  params: RouteParams,
  handler: (
    found: { id: number; site: BuiltSite },
    session: import("#shared/types.ts").AdminSession,
  ) => Promise<Response>,
): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const id = Number(params.id);
    const site = await builtSitesCrudTable.findById(id);
    return site ? handler({ id, site }, session) : notFoundResponse();
  });

/** Owner-gated POST handler wrapper: authenticates, parses CSRF. */
const ownerPost =
  (handler: OwnerPostHandler) =>
  (request: Request, params: RouteParams): Promise<Response> =>
    withOwnerAndSite(request, params, async ({ id, site }) => {
      const csrfResult = await requireCsrfForm(request, () =>
        htmlResponse("CSRF token invalid", 403),
      );
      if (!csrfResult.ok) return csrfResult.response;
      return handler(site, csrfResult.form, id);
    });

/** GET /admin/built-sites/:id/edit */
const handleEditGet = (request: Request, params: RouteParams) =>
  withOwnerAndSite(request, params, async ({ site }, session) => {
    const flash = applyFlash(request);
    const [secrets, updateState] = await Promise.all([
      loadSiteSecretsStatus(site),
      loadBuiltSiteUpdateState(site),
    ]);
    return htmlResponse(
      adminBuiltSiteEditPage(
        site,
        session,
        flash.error,
        flash.success,
        secrets,
        updateState,
      ),
    );
  });

/** POST /admin/built-sites/:id/update — deploy the latest release to the site.
 *
 * Runs the exact self-update path (fetch latest GitHub release, upload + publish
 * its asset) but targets the site's own Bunny script instead of this host's. */
const handleUpdateSite = ownerPost(async (site, _form, id) => {
  if (!getEnv("BUNNY_API_KEY")) {
    return editError(
      id,
      "BUNNY_API_KEY is not configured on this host, so sites can't be updated.",
    );
  }
  if (!site.bunnyScriptId) {
    return editError(
      id,
      "This site has no Bunny script ID, so it can't be updated.",
    );
  }
  // The site migrates on its next request after deploy, so require a recent
  // backup of *this site's* database (taken to our storage by the upgrade
  // workflow) before pushing a new version.
  if (!(await hasRecentBackup(undefined, dbName(site.dbUrl)))) {
    return editError(
      id,
      "No backup of this site in the last hour — back it up before updating.",
    );
  }
  try {
    const result = await settings.withCurrentTask("update", () =>
      deployLatestReleaseToScript(site.bunnyScriptId),
    );
    if (!result.ok) return editError(id, result.error);
    await logActivity(
      `Updated built site '${site.name}' to ${result.value.name} (${result.value.tagName})`,
    );
    return editSuccess(
      id,
      `Updated '${site.name}' to ${result.value.name} — the new version will be active shortly`,
    );
  } catch (e) {
    return editError(id, `Update failed: ${(e as Error).message}`);
  }
});

/** POST /admin/built-sites/:id/rotate-renewal-token */
const handleRotateToken = ownerPost(async (site, _form, id) => {
  if (!isProvisioned(site)) {
    return editError(id, "Renewal is not provisioned for this site");
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
const handleAddSecrets = ownerPost(async (site, _form, id) => {
  const result = await addMissingSiteSecrets(site);
  if (!result.ok) {
    return editError(id, `Secrets could not be set: ${result.error}`);
  }
  if (result.added.length === 0) {
    return editSuccess(id, "No missing secrets — nothing to set");
  }
  const summary = `${result.added.length} missing secret(s): ${result.added.join(", ")}`;
  await logActivity(`Set ${summary} on '${site.name}'`);
  return editSuccess(id, `Set ${summary}`);
});

/** POST /admin/built-sites/:id/bump-deadline */
const handleBumpDeadline = ownerPost(async (site, form, id) => {
  const months = readClampedMonths(form);
  const newIso = addMonthsToRenewalDeadline(site, months);
  const result = await syncReadOnlyFrom(site, newIso);
  if (result.ok) {
    await logActivity(
      `Admin bumped '${site.name}' deadline by ${months} month(s)`,
    );
  }
  return editPushResult(id, result, "Deadline bumped");
});

/** POST /admin/built-sites/:id/override-deadline */
const handleOverrideDeadline = ownerPost(async (site, form, id) => {
  const dateStr = form.getString("date");
  if (!dateStr) return editError(id, "Choose a deadline date");
  const cutoffIso = parseDeadlineDate(dateStr);
  if (!cutoffIso) return editError(id, "Choose a valid deadline date");
  const result = await syncReadOnlyFrom(site, cutoffIso);
  if (result.ok) {
    await logActivity(`Admin overrode '${site.name}' deadline to ${cutoffIso}`);
  }
  return editPushResult(id, result, "Deadline updated");
});

/** POST /admin/built-sites/:id/re-sync-deadline */
const handleReSyncDeadline = ownerPost(async (site, _form, id) => {
  if (!site.readOnlyFrom) return editError(id, "No deadline to re-sync");
  const renewalUrl =
    isProvisioned(site) && site.renewalToken
      ? renewalUrlFor(site.renewalToken)
      : undefined;
  const result = await syncReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  if (result.ok) {
    await logActivity(`Admin re-synced deadline for '${site.name}'`);
  }
  return editPushResult(id, result, "Deadline re-synced");
});

/** POST /admin/built-sites/:id/provision-renewal
 *
 * Gates on the existence of at least one qualifying renewal tier listing so an
 * admin doesn't generate a token that would dead-end at an empty /renew picker.
 * (The customer picks the actual tier at renew time.) */
const handleProvisionRenewal = ownerPost(async (site, form, id) => {
  if (isProvisioned(site)) {
    return editError(id, "Renewal is already provisioned for this site");
  }
  const tier = await pickTierListing();
  if (!tier) {
    return editError(
      id,
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
const handleBuiltSitesListGet = (request: Request) =>
  requireOwnerOr(request, async (session) => {
    applyFlash(request);
    const [sites, tiers] = await Promise.all([
      getAllBuiltSites(),
      getQualifyingTierListings(),
    ]);
    return htmlResponse(
      adminBuiltSitesPage(sites, session, getFlash().success, tiers),
    );
  });

/** Built site routes */
export const builtSitesRoutes = {
  ...crud.routes,
  "GET /admin/built-sites": handleBuiltSitesListGet,
  // Override the CRUD-provided edit GET to pick up flash messages.
  "GET /admin/built-sites/:id/edit": handleEditGet,
  "POST /admin/built-sites/:id/add-secrets": handleAddSecrets,
  "POST /admin/built-sites/:id/bump-deadline": handleBumpDeadline,
  "POST /admin/built-sites/:id/override-deadline": handleOverrideDeadline,
  "POST /admin/built-sites/:id/provision-renewal": handleProvisionRenewal,
  "POST /admin/built-sites/:id/re-sync-deadline": handleReSyncDeadline,
  "POST /admin/built-sites/:id/rotate-renewal-token": handleRotateToken,
  "POST /admin/built-sites/:id/update": handleUpdateSite,
};
