/**
 * Admin update routes — check for and apply software updates
 * Owner-only access
 */

import { OWNER_FORM, ownerPage, withAuth } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { isBunnyCdnEnabled } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  deployRelease,
  fetchLatestRelease,
  formatBuildDate,
  isNewerVersion,
} from "#shared/update.ts";
import {
  adminUpdatePage,
  type UpdatePageState,
} from "#templates/admin/update.tsx";

const UPDATE_PATH = "/admin/update";

/** Extract error message — all callers throw Error instances */
const errorMsg = (e: unknown): string => (e as Error).message;

/** Build the page state from current settings */
const getUpdatePageState = (): UpdatePageState => {
  const latestVersion = settings.latestScriptVersion;
  return {
    buildCommit: (BUILD_COMMIT as string).slice(0, 12),
    buildDate: formatBuildDate(BUILD_TIMESTAMP),
    bunnyConfigured: isBunnyCdnEnabled(),
    latestVersion,
    latestVersionName: settings.latestScriptVersionName,
    updateAvailable: latestVersion !== "" && isNewerVersion(latestVersion),
  };
};

/** GET /admin/update — show current version and update status */
const handleUpdateGet = ownerPage((session) => {
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
      ? `Update available: ${release.name}`
      : "You are running the latest version";
    return redirect(UPDATE_PATH, message, true);
  } catch (e) {
    return errorRedirect(
      UPDATE_PATH,
      `Failed to check for updates: ${errorMsg(e)}`,
    );
  }
};

/** Download and deploy the latest release via Bunny API */
const deployUpdate = async (): Promise<Response> => {
  const latestVersion = settings.latestScriptVersion;
  if (!latestVersion || !isNewerVersion(latestVersion)) {
    return errorRedirect(UPDATE_PATH, "No update available to install");
  }

  try {
    const result = await settings.withCurrentTask("update", async () => {
      const release = await fetchLatestRelease();
      if (!release.assetUrl) {
        throw new Error("Release has no downloadable asset");
      }
      await deployRelease(release.assetUrl);
      return release;
    });

    if (!result.ok) {
      return errorRedirect(UPDATE_PATH, result.error);
    }

    await logActivity(
      `Software updated to ${result.value.name} (${result.value.tagName})`,
    );
    return redirect(
      UPDATE_PATH,
      `Updated to ${result.value.name} — the new version will be active shortly`,
      true,
    );
  } catch (e) {
    return errorRedirect(UPDATE_PATH, `Update failed: ${errorMsg(e)}`);
  }
};

export const updateRoutes = defineRoutes({
  "GET /admin/update": handleUpdateGet,
  "POST /admin/update": (r: Request) => withAuth(r, OWNER_FORM, deployUpdate),
  "POST /admin/update/check": (r: Request) =>
    withAuth(r, OWNER_FORM, checkForUpdate),
});
