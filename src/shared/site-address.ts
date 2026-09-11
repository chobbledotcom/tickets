/**
 * The stable address of a built site. Every host that serves one site on two
 * hostnames is named here once, and every link, monitor, and probe goes
 * through siteBaseUrl — a future deployment host is one new table row.
 */

/** A raw host suffix that some visitors cannot reach, and the stable host
 * suffix for the same site. A host with one address (Deno Deploy) has no row. */
const STABLE_HOST_SUFFIXES: readonly (readonly [
  raw: string,
  stable: string,
])[] = [[".bunny.run", ".b-cdn.net"]];

/** The stable hostname for the same site as `hostname`; any hostname that
 * matches no table row is returned unchanged. */
export const toStableHostname = (hostname: string): string => {
  for (const [raw, stable] of STABLE_HOST_SUFFIXES) {
    if (hostname.endsWith(raw)) {
      return hostname.slice(0, hostname.length - raw.length) + stable;
    }
  }
  return hostname;
};

/** The stable absolute address of a built site — scheme + host only, so a
 * caller can safely append a path. siteUrl may be stored as a bare hostname,
 * so a default scheme is added first (scheme detection is case-insensitive,
 * so an `HTTPS://` URL is not mistaken for a hostname); `new URL(...).origin`
 * then collapses anything past the host and lower-cases the scheme. */
export const siteBaseUrl = (siteUrl: string): string => {
  const withScheme = /^https?:\/\//i.test(siteUrl)
    ? siteUrl
    : `https://${siteUrl}`;
  return toStableHostname(new URL(withScheme).origin);
};
