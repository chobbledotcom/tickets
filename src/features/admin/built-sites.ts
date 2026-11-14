import { mapValues } from "@std/collections";
import { logActivity } from "#db/activity-log.ts";
import { dbName, hasRecentBackup } from "#db/backup-storage.ts";
import {
  type BuiltSite,
  type BuiltSiteFormInput,
  isUpdateTier,
  providerOrBunny,
} from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { t } from "#i18n";
import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { authPageAt } from "#routes/route-gates.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  inBuiltSitesOrder,
  readBuiltSitesSort,
} from "#shared/built-sites-list.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { builtSiteRecord } from "#shared/records/built-sites.ts";
import { isProvisioned, isReservedRenewal } from "#shared/renewal-helpers.ts";
import { getQualifyingTierListings } from "#shared/renewal-tier.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { siteHostingAccess } from "#shared/site-hosting.ts";
import { rotateRenewalToken } from "#shared/site-renewal.ts";
import { provisionSiteScheduler } from "#shared/site-scheduler.ts";
import { addMissingSiteSecrets } from "#shared/site-secrets.ts";
import {
  deployAndReport,
  hostedSiteUpdateGuardIo,
} from "#shared/site-update.ts";
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
import { databaseKeyRoutes } from "./built-site-database-key.ts";
import { builtSiteFormPost } from "./built-site-form.ts";
import { builtSitePage } from "./built-site-page.tsx";
import { answerRenewalPush } from "./built-site-push.ts";
import {
  handleBumpDeadline,
  handleOverrideDeadline,
  handleProvisionRenewal,
  handleReSyncDeadline,
} from "./built-site-renewal-actions.ts";
import { handleSaveSiteSupportMessage } from "./built-site-support-message.ts";
import { answerTab, builtSiteTabPath, refuseTab } from "./built-site-tab.ts";

/**
 * `updates` is carried only when the form submitted a recognised channel. An
 * edit that omits the field — a stale form, or an automation posting the
 * older field set — leaves the stored channel untouched. It never silently
 * resets the channel. On create, the table layer applies DEFAULT_UPDATE_TIER
 * for the absent key.
 */
type BuiltSiteFormValues = FormValues<ReturnType<typeof getBuiltSiteForm>>;

const extractBuiltSiteInput = (
  values: BuiltSiteFormValues,
): BuiltSiteFormInput => {
  // validateForm always sets the select's value (a string, "" when omitted), so
  // no nullish fallback is needed — a non-tier string just is not carried
  // below.
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

const pages = recordPages(builtSiteRecord, {
  form: getBuiltSiteForm(),
  renderDelete: adminBuiltSiteDeletePage,
  renderEditError: builtSitePage.renderEditError,
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  toInput: extractBuiltSiteInput,
});

const handleProvisionSiteScheduler = builtSiteFormPost(
  async (site, _session, _form, _request) =>
    answerTab(
      "maintenance",
      site.id,
      await provisionSiteScheduler(site.id),
      t("built_sites.maintenance_provisioned"),
    ),
);

const handleAddUptimeMonitor = builtSiteFormPost(
  async (site, _session, _form, _request) => {
    const result = await uptimeKumaMonitorService.add(site);
    if (result.ok && result.value.created) {
      await logActivity(`Added Uptime Kuma monitor for '${site.name}'`);
    }
    return answerTab(
      "maintenance",
      site.id,
      result,
      t(
        result.ok && result.value.created
          ? "built_sites.kuma_added"
          : "built_sites.kuma_already_exists",
      ),
    );
  },
);

const runSiteUpdate = async (
  site: BuiltSite,
  deploy: () => Promise<{ tagName: string; name: string }>,
): Promise<Response> => {
  const tabPath = builtSiteTabPath(site.id, "update");
  if (!(await hasRecentBackup(undefined, dbName(site.dbUrl)))) {
    return refuseTab("update", site.id, t("built_sites.backup_required"));
  }
  return deployAndReport({
    deploy,
    guard: hostedSiteUpdateGuardIo(site),
    onError: (message) => errorRedirect(tabPath, message),
    onSuccess: (message) => redirect(tabPath, message, true),
    subject: { kind: "built_site", siteName: site.name },
  });
};

/**
 * The site migrates on its next request after deploy. A recent backup of
 * *this site's* database, taken to our storage by the upgrade workflow, must
 * exist before the push.
 */
const handleUpdateSite = builtSiteFormPost(
  (site, _session, _form, _request) => {
    const access = siteHostingAccess(site, "it can't be updated");
    if (!access.ok) {
      return refuseTab("update", site.id, access.error);
    }
    return runSiteUpdate(site, () =>
      site.hostingProvider === "deno"
        ? deployLatestReleaseToDeno(site.hostingId)
        : deployLatestReleaseToScript(site.hostingId),
    );
  },
);

const handleRotateToken = builtSiteFormPost(
  async (site, _session, _form, _request) => {
    // Rotation runs only on a fully confirmed provisioning. An empty
    // read-only deadline marks a reserved-but-unconfirmed token. The
    // assignment recovery can be re-pushing such a token, and rotating then
    // races it.
    if (!isProvisioned(site) || isReservedRenewal(site)) {
      return refuseTab(
        "renewal",
        site.id,
        t("built_sites.renewal_not_provisioned"),
      );
    }
    const pushed = await rotateRenewalToken(
      site,
      "Rotate token push failed for site ",
    );
    return answerRenewalPush(site, pushed, {
      activity: `Rotated renewal token for '${site.name}'`,
      failure: t("built_sites.token_push_failed"),
      success: t("built_sites.token_rotated"),
    });
  },
);

/**
 * Backfills the secrets we copy to freshly built sites onto an existing site.
 * The handler re-verifies the live secrets first, then sets only the ones
 * still missing. An existing secret is never overwritten: someone changed it
 * for a reason.
 */
const handleAddSecrets = builtSiteFormPost(
  async (site, _session, form, _request) => {
    const result = await addMissingSiteSecrets(
      site,
      form.getFlag("confirm_pair_secrets"),
    );
    if (!result.ok) {
      return refuseTab(
        "secrets",
        site.id,
        t("built_sites.secrets_failed", { error: result.error }),
      );
    }
    if (result.added.length === 0) {
      return answerTab(
        "secrets",
        site.id,
        result,
        t("built_sites.no_missing_secrets"),
      );
    }
    const summary = `${result.added.length} missing secret(s): ${result.added.join(
      ", ",
    )}`;
    await logActivity(`Set ${summary} on '${site.name}'`);
    return answerTab(
      "secrets",
      site.id,
      result,
      t("built_sites.secrets_set", { summary }),
    );
  },
);

/** Overrides the CRUD list: the renewal-tier summary sits beside the table,
 * and the address names the row order. */
const handleBuiltSitesListGet = authPageAt("/admin/built-sites")(
  async (session, request) => {
    const sortOrder = readBuiltSitesSort(new URL(request.url).searchParams);
    const [sites, tiers] = await Promise.all([
      builtSites.getAll(),
      getQualifyingTierListings(),
    ]);
    return adminBuiltSitesPage(
      inBuiltSitesOrder(sortOrder)(sites),
      session,
      getFlash().success,
      tiers,
      sortOrder,
    );
  },
);

/** The whole built-sites section is hidden from the nav when CAN_BUILD_SITES
 * is off, so its routes must not be reachable either. We never serve a page
 * for a disabled feature. Wrapping the route map keeps that gate in one place
 * instead of a repeated check at the top of every handler. */
const builderOnly =
  (handler: RouteHandlerFn): RouteHandlerFn =>
  (request, params) =>
    isBuilderEnabled() ? handler(request, params) : notFoundResponse();

const gateOnBuilder = <Key extends string>(
  routes: Record<Key, (...args: never[]) => unknown>,
): Record<Key, RouteHandlerFn> =>
  mapValues(routes, (handler) => builderOnly(handler as RouteHandlerFn));

/** The Renewal tab writes: the deadline and the renewal token. */
const renewalRoutes = {
  "POST /admin/built-sites/:id/bump-deadline": handleBumpDeadline,
  "POST /admin/built-sites/:id/override-deadline": handleOverrideDeadline,
  "POST /admin/built-sites/:id/provision-renewal": handleProvisionRenewal,
  "POST /admin/built-sites/:id/re-sync-deadline": handleReSyncDeadline,
  "POST /admin/built-sites/:id/rotate-renewal-token": handleRotateToken,
};

/** Built site routes (all gated on CAN_BUILD_SITES via gateOnBuilder). The
 * list GET restates the standard key with its own handler. */
export const adminHandlers = gateOnBuilder(
  defineAdminRoutes({
    ...recordRoutes("builtSites", pages, builtSitePage),
    "GET /admin/built-sites": handleBuiltSitesListGet,
    "POST /admin/built-sites/:id/add-secrets": handleAddSecrets,
    "POST /admin/built-sites/:id/add-uptime-monitor": handleAddUptimeMonitor,
    "POST /admin/built-sites/:id/provision-scheduler":
      handleProvisionSiteScheduler,
    ...renewalRoutes,
    "POST /admin/built-sites/:id/support-message": handleSaveSiteSupportMessage,
    "POST /admin/built-sites/:id/update": handleUpdateSite,
    ...databaseKeyRoutes,
  }),
);
