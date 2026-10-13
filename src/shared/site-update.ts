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

import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite, HostingProvider } from "#db/built-sites/types.ts";
/* jscpd:ignore-start -- imports */
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { getEnv } from "#shared/env.ts";
import { errorMessage } from "#shared/error-message.ts";
import { fetchText } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { type Result, requireSuccess } from "#shared/result.ts";
import { siteBaseUrl } from "#shared/site-address.ts";
import { hasSiteDbCredentials, readSiteSetting } from "#shared/site-db.ts";
import { resolveHostingProvider } from "#shared/site-hosting.ts";
/* jscpd:ignore-end */
import { tryStep } from "#shared/try-step.ts";
import {
  CURRENT_SCRIPT_VERSION_KEY,
  formatBuildDate,
  isNewerVersion,
} from "#shared/update.ts";
import {
  fetchBoundedUpdatePage,
  runUnderUpdateGuard,
  UPDATE_FLAG_LIFTED_VALUE,
  UPDATE_IN_PROGRESS_VAR,
  type UpdateGuardIo,
} from "#shared/update-guard.ts";

/**
 * What an update deploys: this app itself, or one built site by name. The kind
 * picks the catalog variant for the log line and the success flash.
 */
export type UpdateSubject =
  | { kind: "self" }
  | { kind: "built_site"; siteName: string };

/** The release a successful deploy produced. */
export type DeployedRelease = { tagName: string; name: string };

/** Catalog keys for the success flash and the activity-log line, one entry per
 * subject kind. Each call site's copy lives in its own feature's group. */
const DEPLOY_MESSAGE_KEYS: Record<
  UpdateSubject["kind"],
  { flash: string; log: string }
> = {
  built_site: {
    flash: "built_sites.updated_flash",
    log: "built_sites.updated_log",
  },
  self: { flash: "update.updated_flash", log: "update.updated_log" },
};

/** The release name and tag as ICU values, plus the site name a built-site
 * update names. */
const messageValues = (
  subject: UpdateSubject,
  release: DeployedRelease,
): Record<string, unknown> => ({
  name: release.name,
  version: release.tagName,
  ...(subject.kind === "built_site" ? { site: subject.siteName } : {}),
});

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
 * The update-mode guard for one hosted site: the flag rides the hosting
 * provider's secret store, and the wait polls the site's own read-only page.
 * The lift writes an empty value, not a delete: Deno Deploy offers no secret
 * delete, and an empty value reads as unset in the app.
 */
export const hostedSiteUpdateGuardIo = (site: {
  hostingId: string;
  hostingProvider: HostingProvider;
  siteUrl: string;
}): UpdateGuardIo => {
  const setFlag = async (value: string): Promise<void> => {
    requireSuccess(
      await resolveHostingProvider(site.hostingProvider).setSecrets(
        site.hostingId,
        [[UPDATE_IN_PROGRESS_VAR, value]],
      ),
    );
  };
  const pageUrl = `${siteBaseUrl(site.siteUrl)}/read-only`;
  return {
    clearFlag: () => setFlag(UPDATE_FLAG_LIFTED_VALUE),
    fetchPage: async () => {
      const response = await fetchBoundedUpdatePage(fetchText, pageUrl);
      if (!response.ok) {
        throw new Error(
          `The update page check failed (HTTP ${response.status}).`,
        );
      }
      return response.text;
    },
    setFlag,
  };
};

/**
 * Run a release deploy as the current "update" task, write the activity-log
 * line, and turn the outcome into a response. `subject` picks the catalog
 * variant for the log line and the success flash. A thrown deploy failure
 * becomes an error response. The deploy runs inside the update guard: the
 * site refuses writes from the set flag until the new build serves and the
 * flag lifts.
 */
export const deployAndReport = async (opts: {
  deploy: () => Promise<DeployedRelease>;
  guard: UpdateGuardIo;
  onError: (message: string) => Response;
  onSuccess: (message: string) => Response;
  subject: UpdateSubject;
}): Promise<Response> => {
  const result = await tryStep("Update failed", () =>
    settings.withCurrentTask("update", () =>
      // The release tag is the deployed bundle's build tag: build-edge.ts
      // writes .build-tag from the same timestamp it bakes into the bundle.
      runUnderUpdateGuard(
        opts.guard,
        opts.deploy,
        (release) => release.tagName,
      ),
    ),
  );
  if (!result.ok) return opts.onError(result.error);
  const keys = DEPLOY_MESSAGE_KEYS[opts.subject.kind];
  const values = messageValues(opts.subject, result.value);
  const logLine = t(keys.log, values);
  const flash = t(keys.flash, values);
  // The deploy succeeded, so the update succeeded, and the log line only
  // records it. A failed log write must not turn the success into a 500, so
  // the write is best-effort and its failure goes to the error logger.
  try {
    await logActivity(logLine);
  } catch (error) {
    logError({
      code: ErrorCode.DB_QUERY,
      detail: `Update succeeded, but the activity-log write failed: ${errorMessage(error)}`,
      error,
    });
  }
  return opts.onSuccess(flash);
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
