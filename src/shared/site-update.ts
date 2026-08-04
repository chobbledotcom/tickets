/**
 * Built-site update support: read a site's recorded version through its
 * read-only database keys, decide whether it is behind the latest release,
 * and run a release deploy as the current "update" task.
 *
 * The deploy itself reuses the exact self-update path against the site's own
 * hosting script/app; `deployAndReport` wraps that shared tail (task lock,
 * activity log, flash message) for both the self-update page and the
 * built-site Update button.
 */

/* jscpd:ignore-start */
import { resolveHostingProvider } from "#shared/builder.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import type { Result } from "#shared/result.ts";
import { hasSiteDbCredentials, readSiteSetting } from "#shared/site-db.ts";
/* jscpd:ignore-end */
import { tryStep } from "#shared/try-step.ts";
import {
  CURRENT_SCRIPT_VERSION_KEY,
  formatBuildDate,
  isNewerVersion,
} from "#shared/update.ts";

/** State for the built-site update panel. */
export type BuiltSiteUpdateState = {
  /** Host has the provider API key configured (required to deploy at all). */
  providerConfigured: boolean;
  /** Site has a hosting ID to deploy to. */
  hasHostingId: boolean;
  /** Human-readable version the site reported, or null when unknown. */
  siteVersionLabel: string | null;
  /** Error reading the site's database, if we tried and failed. */
  siteVersionError: string | null;
  /** Latest release tag the host knows about ("" when never checked). */
  latestVersion: string;
  /** Latest release display name. */
  latestVersionName: string;
  /** The latest known release is newer than what the site is running. */
  updateAvailable: boolean;
  /** The site is on the latest known release. */
  upToDate: boolean;
};

/**
 * Run a release deploy as the current "update" task, write the activity-log
 * line, and turn the outcome into a response. `logPrefix` opens the log line
 * ("Software updated" / "Updated built site '…'") and `successPrefix` opens
 * the success flash ("Updated" / "Updated '…'"); both finish with the
 * released version. A thrown deploy failure becomes an error response.
 */
export const deployAndReport = async (opts: {
  deploy: () => Promise<{ tagName: string; name: string }>;
  logPrefix: string;
  successPrefix: string;
  onSuccess: (message: string) => Response;
  onError: (message: string) => Response;
}): Promise<Response> => {
  const result = await tryStep("Update failed", () =>
    settings.withCurrentTask("update", opts.deploy),
  );
  if (!result.ok) return opts.onError(result.error);
  await logActivity(
    `${opts.logPrefix} to ${result.value.name} (${result.value.tagName})`,
  );
  return opts.onSuccess(
    `${opts.successPrefix} to ${result.value.name} — the new version will be active shortly`,
  );
};

/** Read the version a built site recorded for itself, via its read-only keys. */
export const readSiteScriptVersion = (
  site: BuiltSite,
): Promise<Result<string | null>> =>
  readSiteSetting(site, CURRENT_SCRIPT_VERSION_KEY);

/**
 * Gather the update panel state for a site: its recorded version (when we hold
 * its database keys) compared against the latest release the host knows about.
 */
export const loadBuiltSiteUpdateState = async (
  site: BuiltSite,
): Promise<BuiltSiteUpdateState> => {
  const latestVersion = settings.latestScriptVersion;
  const latestVersionName = settings.latestScriptVersionName;

  let siteVersion: string | null = null;
  let siteVersionError: string | null = null;
  if (hasSiteDbCredentials(site)) {
    const result = await readSiteScriptVersion(site);
    if (result.ok) siteVersion = result.value;
    else siteVersionError = result.error;
  }

  const haveLatest = latestVersion !== "";
  const updateAvailable =
    Boolean(siteVersion) &&
    haveLatest &&
    isNewerVersion(latestVersion, siteVersion!);
  const upToDate = Boolean(siteVersion) && haveLatest && !updateAvailable;

  // The provider's own config env var is the single source for "can deploy".
  const providerConfigured = Boolean(
    getEnv(resolveHostingProvider(site.hostingProvider).configEnvVar),
  );

  return {
    hasHostingId: Boolean(site.hostingId),
    latestVersion,
    latestVersionName,
    providerConfigured,
    siteVersionError,
    siteVersionLabel: siteVersion ? formatBuildDate(siteVersion) : null,
    updateAvailable,
    upToDate,
  };
};
