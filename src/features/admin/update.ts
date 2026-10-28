import { defineAdminRoutes } from "#routes/admin/route-tables.ts";

/**
 * Admin update routes — check for and apply software updates
 * Owner-only access
 */

import { hasRecentBackup } from "#db/backup-storage.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
/* jscpd:ignore-start -- imports */
import {
  authPage,
  formPolicyAt,
  pageGuardFor,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import {
  getBunnyScriptId,
  getEffectiveDomain,
  isBunnyCdnEnabled,
} from "#shared/config.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  deployAndReport,
  hostedSiteUpdateGuardIo,
} from "#shared/site-update.ts";
import {
  deployLatestReleaseToScript,
  fetchLatestRelease,
  formatBuildDate,
  isNewerVersion,
} from "#shared/update.ts";
import type { UpdateGuardIo } from "#shared/update-guard.ts";
import {
  adminUpdatePage,
  type UpdatePageState,
} from "#templates/admin/update.tsx";

/* jscpd:ignore-end */

const UPDATE_PATH = "/admin/update";

/** The update-mode guard for this host's own script. The flag rides the
 * host's own Bunny script. The wait polls the host's own read-only page
 * through its public domain. */
const selfUpdateGuardIo = (): UpdateGuardIo =>
  hostedSiteUpdateGuardIo({
    hostingId: getBunnyScriptId(),
    hostingProvider: "bunny",
    siteUrl: `https://${getEffectiveDomain()}`,
  });

/** Extract error message — all callers throw Error instances */
const errorMsg = (e: unknown): string => (e as Error).message;

/** Build the page state from current settings */
const getUpdatePageState = (): UpdatePageState => {
  const latestVersion = settings.latestScriptVersion;
  return {
    buildCommit: (BUILD_COMMIT as string).slice(0, 12),
    buildDate: formatBuildDate(BUILD_TIMESTAMP),
    latestVersion,
    latestVersionName: settings.latestScriptVersionName,
    providerConfigured: isBunnyCdnEnabled(),
    updateAvailable: latestVersion !== "" && isNewerVersion(latestVersion),
  };
};

/** GET /admin/update — show current version and update status */
const handleUpdateGet = authPage(
  pageGuardFor(adminDestinationAt("/admin/update")),
)((session) => {
  const flash = getFlash();
  return adminUpdatePage(
    session,
    getUpdatePageState(),
    flash.error,
    flash.success,
  );
});

/** Check GitHub for a newer release, store result, redirect with flash */
const checkForUpdate = async (): Promise<Response> => {
  try {
    const release = await fetchLatestRelease();
    await settings.update.latestScriptVersion(release.tagName);
    await settings.update.latestScriptVersionName(release.name);

    const message = isNewerVersion(release.tagName)
      ? t("update.update_available_flash", { version: release.name })
      : t("update.running_latest_flash");
    return redirect(UPDATE_PATH, message, true);
  } catch (e) {
    return errorRedirect(
      UPDATE_PATH,
      t("update.check_failed", { error: errorMsg(e) }),
    );
  }
};

/** Download and deploy the latest release via Bunny API */
const deployUpdate = async (): Promise<Response> => {
  const latestVersion = settings.latestScriptVersion;
  if (!latestVersion || !isNewerVersion(latestVersion)) {
    return errorRedirect(UPDATE_PATH, t("update.no_update_to_install"));
  }
  // Migrations no longer back up inline, so refuse to deploy a new version
  // (which migrates on first request) unless a fresh backup already exists.
  if (!(await hasRecentBackup())) {
    return errorRedirect(UPDATE_PATH, t("update.backup_required"));
  }

  return deployAndReport({
    deploy: () => deployLatestReleaseToScript(),
    guard: selfUpdateGuardIo(),
    onError: (message) => errorRedirect(UPDATE_PATH, message),
    onSuccess: (message) => redirect(UPDATE_PATH, message, true),
    subject: { kind: "self" },
  });
};

export const adminHandlers = defineAdminRoutes({
  "GET /admin/update": handleUpdateGet,
  "POST /admin/update": (r: Request) =>
    withAuth(r, formPolicyAt("/admin/update"), deployUpdate),
  "POST /admin/update/check": (r: Request) =>
    withAuth(r, formPolicyAt("/admin/update/check"), checkForUpdate),
});
