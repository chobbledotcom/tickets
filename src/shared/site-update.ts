/**
 * Built-site update support: read a site's recorded version through its
 * read-only database keys and decide whether it is behind the latest release.
 *
 * The deploy itself reuses the exact self-update path against the site's own
 * hosting script/app; this module only gathers the comparison state shown next
 * to the Update button.
 */

import type { BuiltSite } from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import {
  hasSiteDbCredentials,
  readSiteSetting,
  type SiteDbResult,
} from "#shared/site-db.ts";
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

/** Read the version a built site recorded for itself, via its read-only keys. */
export const readSiteScriptVersion = (
  site: BuiltSite,
): Promise<SiteDbResult<string | null>> =>
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

  const providerConfigured =
    site.hostingProvider === "deno"
      ? Boolean(getEnv("DENO_DEPLOY_TOKEN"))
      : Boolean(getEnv("BUNNY_API_KEY"));

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
