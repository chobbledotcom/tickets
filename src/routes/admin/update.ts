/**
 * Admin update routes — check for and apply software updates
 * Owner-only access
 */

import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#lib/build-info.ts";
import { isBunnyCdnEnabled } from "#lib/config.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { settings } from "#lib/db/settings.ts";
import {
  deployRelease,
  fetchLatestRelease,
  formatBuildDate,
  isNewerVersion,
} from "#lib/update.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  applyFlash,
  errorRedirect,
  htmlResponse,
  OWNER_FORM,
  redirect,
  requireOwnerOr,
  withAuth,
} from "#routes/utils.ts";
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
    buildDate: formatBuildDate(BUILD_TIMESTAMP),
    buildCommit: (BUILD_COMMIT as string).slice(0, 12),
    latestVersion,
    latestVersionName: settings.latestScriptVersionName,
    updateAvailable: latestVersion !== "" && isNewerVersion(latestVersion),
    bunnyConfigured: isBunnyCdnEnabled(),
  };
};

/** GET /admin/update — show current version and update status */
const handleUpdateGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, (session) => {
    const { error, success } = applyFlash(request);
    return htmlResponse(
      adminUpdatePage(session, getUpdatePageState(), error, success),
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
  "POST /admin/update/check": (r: Request) =>
    withAuth(r, OWNER_FORM, checkForUpdate),
  "POST /admin/update": (r: Request) => withAuth(r, OWNER_FORM, deployUpdate),
});
