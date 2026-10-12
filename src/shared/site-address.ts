/**
 * The stable address of a built site. Every host that serves one site on two
 * hostnames is named here once. Every link, monitor, and probe goes through
 * siteBaseUrl. A future deployment host is one new table row.
 */

/** A raw host suffix that some visitors cannot reach, and the stable host
 * suffix for the same site. A host with one address (Deno Deploy) has no row. */
const STABLE_HOST_SUFFIXES: readonly (readonly [
  raw: string,
  stable: string,
])[] = [[".bunny.run", ".b-cdn.net"]];

/** The saved URL's raw Bunny zone host suffix, and the CDN host suffix a
 * visitor opens. Only the host carries the suffix, so a match never lands on
 * a path segment. */
const ZONE_HOST_SUFFIX = ".bunny.net";

/** The absolute address a URL renders as: origin, path, query, and hash,
 * without the slash-only path. */
const renderedUrl = (url: URL): string =>
  `${url.origin}${
    url.pathname === "/" ? "" : url.pathname
  }${url.search}${url.hash}`;

/** The "(visit)" address for a saved site URL: the same URL with its host's
 * raw zone suffix swapped for the CDN one. A custom domain, or a host that is
 * already the CDN name, comes back unchanged. A saved bare hostname, with or
 * without a port, becomes its https address, never a relative one. A saved
 * value that names a scheme other than http or https, or that is not a valid
 * URL, returns undefined. The caller then renders no link. */
export const visitSiteUrl = (siteUrl: string): string | undefined => {
  // WHATWG's scheme grammar at the string start. A digit-only segment before
  // the first slash names a bare host's port: "example.com:8443" is a
  // hostname with a port. "javascript:alert(1)" and "ftp://example.com" bear
  // a scheme that no visit link can carry.
  const scheme = /^([a-z][a-z0-9+.-]*):([^/]*)(\/.*)?$/i.exec(siteUrl);
  // Both groups always take part in a match, so a match always holds them.
  const bare = scheme === null || /^\d+$/.test(scheme[2]!);
  if (scheme !== null && !bare && !/^https?$/i.test(scheme[1]!)) return;
  const withScheme = bare ? `https://${siteUrl}` : siteUrl;
  if (!URL.canParse(withScheme)) return;
  const url = new URL(withScheme);
  const { hostname } = url;
  if (!hostname.endsWith(ZONE_HOST_SUFFIX)) {
    return bare ? renderedUrl(url) : siteUrl;
  }
  url.hostname = `${hostname.slice(0, hostname.length - ZONE_HOST_SUFFIX.length)}.b-cdn.net`;
  return renderedUrl(url);
};

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

/** The stable absolute address of a built site — the scheme, host, and any
 * non-default port of the stored URL, with the host mapped to its stable
 * twin, so a caller can safely append a path. siteUrl may be stored as a bare
 * hostname, so a default scheme is added first (scheme detection is
 * case-insensitive, so an `HTTPS://` URL is not mistaken for a hostname), and
 * `new URL(...).origin` drops anything past the host. */
export const siteBaseUrl = (siteUrl: string): string => {
  const withScheme = /^https?:\/\//i.test(siteUrl)
    ? siteUrl
    : `https://${siteUrl}`;
  const url = new URL(withScheme);
  url.hostname = toStableHostname(url.hostname);
  return url.origin;
};
