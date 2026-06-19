/**
 * Self-update logic: check for new releases on GitHub, download and deploy to Bunny.
 *
 * Flow:
 * 1. Check: fetch latest GitHub release, compare tag date vs BUILD_TIMESTAMP
 * 2. Deploy: download release asset, upload via bunny-cdn module
 */

import { lazyRef } from "#fp";
import { BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { deployScriptCode } from "#shared/bunny-cdn.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { logDebug } from "#shared/logger.ts";

/** GitHub repo URL — update here if the repo moves */
export const GITHUB_REPO = "chobbledotcom/tickets";

/**
 * Plaintext settings key under which the running build records its own version
 * (the build timestamp). Stored unencrypted on purpose: a parent host reads it
 * from a built site's database using only the site's read-only keys, so it can
 * tell which release the site is on. Mirrors the raw schema markers written by
 * the migrator (db_schema_hash / latest_db_update), not a snapshot setting.
 */
export const CURRENT_SCRIPT_VERSION_KEY = "current_script_version";

/** GitHub releases page URL */
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

/** GitHub API URL for the latest release */
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Release info returned from GitHub */
export type ReleaseInfo = {
  tagName: string;
  name: string;
  publishedAt: string;
  assetUrl: string | null;
};

/**
 * Parse a release tag (vYYYY-MM-DD-HHMMSS) to a Date.
 * Returns null if the tag doesn't match the expected format.
 */
export const parseReleaseTag = (tag: string): Date | null => {
  const match = tag.match(/^v(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
};

/**
 * Override for BUILD_TIMESTAMP in tests. When set, isNewerVersion uses
 * this instead of the compile-time constant.
 */
const [getBuildTimestampOverride, setBuildTimestampOverride] = lazyRef<
  string | null
>(() => null);

/** Set a build timestamp override for testing. Pass null to clear. */
export const setBuildTimestampForTest = (ts: string | null): void => {
  setBuildTimestampOverride(ts);
};

/** Get the effective build timestamp (override or real). */
const getEffectiveBuildTimestamp = (): string =>
  getBuildTimestampOverride() ?? BUILD_TIMESTAMP;

/**
 * Check if a release tag is newer than a build timestamp. Defaults to this
 * host's own build (self-update check); pass `buildTimestamp` to compare a
 * built site's recorded version against the latest release. Returns false when
 * the timestamp is empty (development) or the tag is unparseable.
 */
export const isNewerVersion = (
  tagName: string,
  buildTimestamp: string = getEffectiveBuildTimestamp(),
): boolean => {
  const releaseDate = parseReleaseTag(tagName);
  if (!releaseDate || !buildTimestamp) return false;
  return releaseDate.getTime() > new Date(buildTimestamp).getTime();
};

/**
 * Record the running build's version into this database's `settings` table so a
 * parent host can read it back (read-only) and tell which release we are on.
 * Writes only when the stored value differs from the running build, so the
 * common unchanged path costs a single indexed read and no write. Best-effort:
 * any failure is logged and swallowed so it can never block boot, and it is a
 * no-op for development/test builds where the timestamp is empty.
 */
export const recordScriptVersion = async (): Promise<void> => {
  const version = getEffectiveBuildTimestamp();
  if (!version) return;
  try {
    const row = await queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [CURRENT_SCRIPT_VERSION_KEY],
    );
    if (row?.value === version) return;
    await execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [CURRENT_SCRIPT_VERSION_KEY, version],
    );
  } catch (e) {
    logDebug(
      "Migration",
      `Failed to record script version: ${(e as Error).message}`,
    );
  }
};

/**
 * Format a build timestamp for display.
 */
export const formatBuildDate = (iso: string): string => {
  if (!iso) return "Development build";
  const d = new Date(iso);
  return d.toUTCString().replace(" GMT", " UTC");
};

/**
 * Fetch the latest release info from GitHub.
 * Throws on network/API errors.
 */
export const fetchLatestRelease = async (): Promise<ReleaseInfo> => {
  const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  const data = await response.json();
  const asset = data.assets?.find(
    (a: { name: string }) => a.name === "bunny-script.ts",
  );
  return {
    assetUrl: asset?.browser_download_url ?? null,
    name: data.name,
    publishedAt: data.published_at,
    tagName: data.tag_name,
  };
};

/**
 * Download a release asset from GitHub and deploy it to a Bunny edge script.
 * Defaults to this host's own script; pass `scriptId` to deploy the same
 * release to another site. Uses the shared bunny-cdn module for upload+publish.
 */
export const deployRelease = async (
  assetUrl: string,
  scriptId?: number | string,
): Promise<void> => {
  const assetResponse = await fetch(assetUrl);
  if (!assetResponse.ok) {
    throw new Error(
      `Failed to download release asset: ${assetResponse.status}`,
    );
  }
  const code = await assetResponse.text();

  const result = await deployScriptCode(code, scriptId);
  if (!result.ok) {
    throw new Error(result.error);
  }
};

/**
 * Fetch the latest GitHub release and deploy its asset to a Bunny edge script,
 * returning the release on success. This is the exact deploy our self-update
 * runs; pass `scriptId` to run it against a built site's script instead.
 * Throws on any failure (no release asset, download, or deploy error).
 */
export const deployLatestReleaseToScript = async (
  scriptId?: number | string,
): Promise<ReleaseInfo> => {
  const release = await fetchLatestRelease();
  if (!release.assetUrl) {
    throw new Error("Release has no downloadable asset");
  }
  await deployRelease(release.assetUrl, scriptId);
  return release;
};
