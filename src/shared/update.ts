/**
 * Self-update logic: check for new releases on GitHub, download and deploy to Bunny.
 *
 * Flow:
 * 1. Check: fetch latest GitHub release, compare tag date vs BUILD_TIMESTAMP
 * 2. Deploy: download release asset, upload via bunny-cdn module
 */

import { lazyRef } from "#fp";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { deployScriptCode } from "#shared/bunny-cdn.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
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

/**
 * Plaintext settings key under which the running build records the git commit it
 * was built from (the embedded BUILD_COMMIT). Stored next to the version marker
 * so a database backup carries the commit the site was running when it was
 * taken — that is how a restore knows which commit to redeploy to return the
 * code to that point in time. Empty in development/test builds.
 */
const CURRENT_SCRIPT_COMMIT_KEY = "current_script_commit";

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

/** Override for BUILD_COMMIT in tests; null falls back to the compile-time constant. */
const [getBuildCommitOverride, setBuildCommitOverride] = lazyRef<string | null>(
  () => null,
);

/** Set a build commit override for testing. Pass null to clear. */
export const setBuildCommitForTest = (commit: string | null): void => {
  setBuildCommitOverride(commit);
};

/** Get the effective build commit (override or real). */
const getEffectiveBuildCommit = (): string =>
  getBuildCommitOverride() ?? BUILD_COMMIT;

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

/** Read a plaintext settings marker's value, or "" when the row is absent. */
const readSettingMarker = async (key: string): Promise<string> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return row?.value ?? "";
};

/**
 * Upsert a plaintext settings marker, writing only when the stored value
 * differs (so the unchanged path costs one indexed read and no write). A blank
 * value is a no-op, matching development/test builds where build info is empty.
 */
const recordSettingMarker = async (
  key: string,
  value: string,
): Promise<void> => {
  if (!value) return;
  if ((await readSettingMarker(key)) === value) return;
  await execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
    key,
    value,
  ]);
};

/**
 * Sync the commit marker to the running build: upsert when the build embeds a
 * commit, but *clear* a previously-recorded one when a real built bundle ships
 * without one (e.g. `deno task deploy:edge`, which doesn't set BUILD_COMMIT) —
 * otherwise a stale commit from an earlier CI deploy would linger and a later
 * backup/restore would name the wrong commit. "Real built bundle" is gated on a
 * non-empty `version` (build timestamp): a dev/source boot has neither value,
 * so it stays a pure no-op and never wipes a remote DB's commit.
 */
const syncCommitMarker = async (
  version: string,
  commit: string,
): Promise<void> => {
  if (commit) return recordSettingMarker(CURRENT_SCRIPT_COMMIT_KEY, commit);
  if (!version) return;
  await execute("DELETE FROM settings WHERE key = ?", [
    CURRENT_SCRIPT_COMMIT_KEY,
  ]);
};

/**
 * Record the running build's version *and* commit into this database's
 * `settings` table so a parent host can read them back (read-only) — both which
 * release we are on and which commit it was built from. The commit is what a
 * backup carries so a restore can redeploy that exact point in time.
 * Best-effort: any failure is logged and swallowed so it can never block boot,
 * and each marker is a no-op for development/test builds where it is empty.
 */
export const recordScriptVersion = async (): Promise<void> => {
  try {
    const version = getEffectiveBuildTimestamp();
    await recordSettingMarker(CURRENT_SCRIPT_VERSION_KEY, version);
    await syncCommitMarker(version, getEffectiveBuildCommit());
  } catch (e) {
    logDebug(
      "Migration",
      `Failed to record script version: ${(e as Error).message}`,
    );
  }
};

/**
 * Read the git commit a database recorded for its running script, or "" when
 * unset (older backups, or development builds). A restore reads this from the
 * just-restored data to tell the operator which commit to redeploy.
 */
export const readRecordedScriptCommit = (): Promise<string> =>
  readSettingMarker(CURRENT_SCRIPT_COMMIT_KEY);

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

/** Download a release asset URL and return the source code text. */
const downloadReleaseAsset = async (assetUrl: string): Promise<string> => {
  const assetResponse = await fetch(assetUrl);
  if (!assetResponse.ok) {
    throw new Error(
      `Failed to download release asset: ${assetResponse.status}`,
    );
  }
  return assetResponse.text();
};

/** Fetch the latest release and download its asset, throwing on any failure. */
const fetchAndDownloadRelease = async (): Promise<{
  release: ReleaseInfo;
  code: string;
}> => {
  const release = await fetchLatestRelease();
  if (!release.assetUrl) {
    throw new Error("Release has no downloadable asset");
  }
  const code = await downloadReleaseAsset(release.assetUrl);
  return { code, release };
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
  const code = await downloadReleaseAsset(assetUrl);
  const result = await deployScriptCode(code, scriptId);
  if (!result.ok) {
    throw new Error(result.error);
  }
};

/** Fetch, download, and deploy the latest release via `deploy`, throwing on any failure. */
const deployLatest = async (
  deploy: (
    code: string,
  ) => Promise<{ ok: false; error: string } | { ok: true }>,
): Promise<ReleaseInfo> => {
  const { code, release } = await fetchAndDownloadRelease();
  const result = await deploy(code);
  if (!result.ok) throw new Error(result.error);
  return release;
};

/**
 * Fetch the latest GitHub release and deploy its asset to a Bunny edge script,
 * returning the release on success. This is the exact deploy our self-update
 * runs; pass `scriptId` to run it against a built site's script instead.
 * Throws on any failure (no release asset, download, or deploy error).
 */
export const deployLatestReleaseToScript = (
  scriptId?: number | string,
): Promise<ReleaseInfo> =>
  deployLatest((code) => deployScriptCode(code, scriptId));

/**
 * Fetch the latest GitHub release and deploy its asset to a Deno Deploy app,
 * returning the release on success.
 * Throws on any failure (no release asset, download, or deploy error).
 */
export const deployLatestReleaseToDeno = (
  appId: string,
): Promise<ReleaseInfo> =>
  deployLatest((code) => denoDeployApi.deployCode(appId, code));
