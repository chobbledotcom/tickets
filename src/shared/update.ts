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

/** GitHub repo URL — update here if the repo moves */
export const GITHUB_REPO = "chobbledotcom/tickets";

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
 * Check if a release tag represents a version newer than the current build.
 * Returns false in development (no build timestamp) or for unparseable tags.
 */
export const isNewerVersion = (tagName: string): boolean => {
  const releaseDate = parseReleaseTag(tagName);
  const ts = getEffectiveBuildTimestamp();
  if (!releaseDate || !ts) return false;
  return releaseDate.getTime() > new Date(ts).getTime();
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
 * Download a release asset from GitHub and deploy it to Bunny CDN.
 * Uses the shared bunny-cdn module for the upload + publish step.
 */
export const deployRelease = async (assetUrl: string): Promise<void> => {
  const assetResponse = await fetch(assetUrl);
  if (!assetResponse.ok) {
    throw new Error(
      `Failed to download release asset: ${assetResponse.status}`,
    );
  }
  const code = await assetResponse.text();

  const result = await deployScriptCode(code);
  if (!result.ok) {
    throw new Error(result.error);
  }
};
