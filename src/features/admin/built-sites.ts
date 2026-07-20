import { mapValues } from "@std/collections";
import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin built site management routes - owner only
 */

/* jscpd:ignore-start */
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash, requireCsrfForm } from "#routes/csrf.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
/* jscpd:ignore-end */
import { siteHostingAccess } from "#shared/builder.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { dbName, hasRecentBackup } from "#shared/db/backup-storage.ts";
import type { BuiltSite, BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import {
  builtSites,
  builtSitesCrudTable,
  isUpdateTier,
  providerOrBunny,
} from "#shared/db/built-sites.ts";
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
import { addMissingSiteSecrets } from "#shared/site-secrets.ts";
import { deployAndReport } from "#shared/site-update.ts";
import {
  deployLatestReleaseToDeno,
  deployLatestReleaseToScript,
} from "#shared/update.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
} from "#templates/admin/built-sites.tsx";
import { getBuiltSiteForm } from "#templates/fields/admin.ts";
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

const crud = createOwnerCrudHandlers({
  getAll: builtSites.getAll,
  getName: (s) => s.name,
  getRowPath: (site) => builtSitePage.path(site.id),
  listPath: "/admin/built-sites",
  operations: builtSitesResource,
  renderDelete: adminBuiltSiteDeletePage,
  renderEditError: builtSitePage.renderEditError,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  singular: "Built site",
});

type BuiltSiteTab = "renewal" | "secrets" | "update";
const tabSuccess = (id: number, tab: BuiltSiteTab, message: string): Response =>
  redirect(builtSitePage.path(id, tab), message, true);
const tabError = (id: number, tab: BuiltSiteTab, message: string): Response =>
  errorRedirect(builtSitePage.path(id, tab), message);

const editPushResult = (
  id: number,
  result: { ok: true } | { ok: false; error: string },
  success: string,
): Response =>
  result.ok
    ? tabSuccess(id, "renewal", success)
    : tabError(
        id,
        "renewal",
        `Deadline could not be pushed to the site: ${result.error}`,
      );

const editPushOk = (
  id: number,
  pushOk: boolean,
  success: string,
  failure: string,
): Response =>
  pushOk
    ? tabSuccess(id, "renewal", success)
    : tabError(id, "renewal", failure);

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

const builtSiteHandler = createIdEntityHandler<BuiltSite>(
  builtSitesCrudTable.findById,
);
type BuiltSitePost = (
  site: BuiltSite,
  form: { getString: (key: string) => string },
  id: number,
) => Promise<Response>;
const builtSiteHandlers = {
  post: (action: BuiltSitePost): IdRouteHandler =>
    builtSiteHandler(requireOwnerOr)(
      async (site, _session, request, { id }) => {
        const csrf = await requireCsrfForm(request, () =>
          htmlResponse("CSRF token invalid", 403),
        );
        return csrf.ok ? action(site, csrf.form, id) : csrf.response;
      },
    ),
};

type EditResult = Awaited<ReturnType<typeof tabError>>;

const runSiteUpdate = async (
  site: BuiltSite,
  id: number,
  deploy: () => Promise<{ tagName: string; name: string }>,
): Promise<EditResult> => {
  if (!(await hasRecentBackup(undefined, dbName(site.dbUrl)))) {
    return tabError(
      id,
      "update",
      "No backup of this site in the last hour — back it up before updating.",
    );
  }
  return deployAndReport({
    deploy,
    logPrefix: `Updated built site '${site.name}'`,
    onError: (message) => tabError(id, "update", message),
    onSuccess: (message) => tabSuccess(id, "update", message),
    successPrefix: `Updated '${site.name}'`,
  });
};

/** POST /admin/built-sites/:id/update — deploy the latest release to the site.
 *
 * The site migrates on its next request after deploy, so a recent backup of
 * *this site's* database (taken to our storage by the upgrade workflow) is
 * required before pushing a new version. */
const handleUpdateSite = builtSiteHandlers.post(async (site, _form, id) => {
  const access = siteHostingAccess(site, "it can't be updated");
  if (!access.ok) return tabError(id, "update", access.error);
  return runSiteUpdate(site, id, () =>
    site.hostingProvider === "deno"
      ? deployLatestReleaseToDeno(site.hostingId)
      : deployLatestReleaseToScript(site.hostingId),
  );
});

/** POST /admin/built-sites/:id/rotate-renewal-token */
const handleRotateToken = builtSiteHandlers.post(async (site, _form, id) => {
  if (!isProvisioned(site)) {
    return tabError(id, "renewal", "Renewal is not provisioned for this site");
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
const handleAddSecrets = builtSiteHandlers.post(async (site, _form, id) => {
  const result = await addMissingSiteSecrets(site);
  if (!result.ok) {
    return tabError(id, "secrets", `Secrets could not be set: ${result.error}`);
  }
  if (result.added.length === 0) {
    return tabSuccess(id, "secrets", "No missing secrets — nothing to set");
  }
  const summary = `${result.added.length} missing secret(s): ${result.added.join(
    ", ",
  )}`;
  await logActivity(`Set ${summary} on '${site.name}'`);
  return tabSuccess(id, "secrets", `Set ${summary}`);
});

/** POST /admin/built-sites/:id/bump-deadline */
const handleBumpDeadline = builtSiteHandlers.post(async (site, form, id) => {
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
const handleOverrideDeadline = builtSiteHandlers.post(
  async (site, form, id) => {
    const dateStr = form.getString("date");
    if (!dateStr) return tabError(id, "renewal", "Choose a deadline date");
    const cutoffIso = parseDeadlineDate(dateStr);
    if (!cutoffIso) {
      return tabError(id, "renewal", "Choose a valid deadline date");
    }
    const result = await syncReadOnlyFrom(site, cutoffIso);
    if (result.ok) {
      await logActivity(
        `Admin overrode '${site.name}' deadline to ${cutoffIso}`,
      );
    }
    return editPushResult(id, result, "Deadline updated");
  },
);

/** POST /admin/built-sites/:id/re-sync-deadline */
const handleReSyncDeadline = builtSiteHandlers.post(async (site, _form, id) => {
  if (!site.readOnlyFrom) {
    return tabError(id, "renewal", "No deadline to re-sync");
  }
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
const handleProvisionRenewal = builtSiteHandlers.post(
  async (site, form, id) => {
    if (isProvisioned(site)) {
      return tabError(
        id,
        "renewal",
        "Renewal is already provisioned for this site",
      );
    }
    const tier = await pickTierListing();
    if (!tier) {
      return tabError(
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
  },
);

/** GET /admin/built-sites — overrides the CRUD list so we can render the
 * renewal-tier summary alongside the sites table. */
const handleBuiltSitesListGet = (request: Request) =>
  requireOwnerOr(request, async (session) => {
    applyFlash(request);
    const [sites, tiers] = await Promise.all([
      builtSites.getAll(),
      getQualifyingTierListings(),
    ]);
    return htmlResponse(
      adminBuiltSitesPage(sites, session, getFlash().success, tiers),
    );
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

/** Built site routes (all gated on CAN_BUILD_SITES via gateOnBuilder). */
export const adminHandlers = gateOnBuilder(
  handlersFor("builtSites")({
    getBuiltSites: handleBuiltSitesListGet,
    getBuiltSitesById: (request, { id }) =>
      builtSitePage.renderTab(request, id, ""),
    getBuiltSitesByIdByTab: (request, { id, tab }) =>
      builtSitePage.renderTab(request, id, tab),
    getBuiltSitesByIdDelete: crud.deleteGet,
    getBuiltSitesNew: crud.newGet,
    postBuiltSites: crud.createPost,
    postBuiltSitesByIdAddSecrets: handleAddSecrets,
    postBuiltSitesByIdBumpDeadline: handleBumpDeadline,
    postBuiltSitesByIdDelete: crud.deletePost,
    postBuiltSitesByIdEdit: crud.editPost,
    postBuiltSitesByIdOverrideDeadline: handleOverrideDeadline,
    postBuiltSitesByIdProvisionRenewal: handleProvisionRenewal,
    postBuiltSitesByIdReSyncDeadline: handleReSyncDeadline,
    postBuiltSitesByIdRotateRenewalToken: handleRotateToken,
    postBuiltSitesByIdUpdate: handleUpdateSite,
  }),
);
