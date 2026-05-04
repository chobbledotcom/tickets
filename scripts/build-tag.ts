/**
 * Release tag formatting for build output.
 *
 * The build script writes the tag to .build-tag so the release workflow can
 * push a matching git tag. The same format is parsed by src/shared/update.ts
 * when the running edge script compares itself to the latest release, so
 * any change to this format must be kept in sync with parseReleaseTag there.
 */

/**
 * Format an ISO timestamp as a release-style tag: vYYYY-MM-DD-HHMMSS (UTC).
 */
export const isoToTag = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
