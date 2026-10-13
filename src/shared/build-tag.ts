/**
 * Release tag formatting for build output.
 *
 * The build script writes the tag to .build-tag so the release workflow can
 * push a matching git tag. The running edge script parses the same format in
 * src/shared/update.ts when it compares itself to the latest release. Keep
 * this format in sync with parseReleaseTag there.
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
