/**
 * SSRF guard for admin-supplied URLs that the server fetches itself.
 *
 * Safe URLs must be absolute https:// URLs with a real domain name. IP
 * literals, localhost-style names, and internal/private hostnames are all
 * rejected. This is hostname-based and best-effort: it does not resolve DNS,
 * so it does not defend against DNS rebinding, but it blocks the obvious
 * "fetch an internal service" cases and forces TLS.
 */

/** Internal hostname suffixes/names that must never be fetched server-side. */
const isInternalHostname = (h: string): boolean =>
  h === "localhost" ||
  h.endsWith(".localhost") ||
  h === "local" ||
  h.endsWith(".local") ||
  h.endsWith(".internal");

/** True when the host is an IPv4 or IPv6 literal rather than a real domain. */
const isIpLiteral = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return true;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(h);
};

/** True when a hostname is a public-looking domain name. */
const isDomainHostname = (host: string): boolean =>
  host.includes(".") && !host.endsWith(".");

/**
 * True when `raw` is a safe URL for the server to fetch: a syntactically valid
 * https:// URL whose host is a real domain name and not internal/private.
 */
export const isSafeServerFetchUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    isDomainHostname(host) &&
    !isInternalHostname(host) &&
    !isIpLiteral(host)
  );
};

/**
 * Validate a user-supplied URL and return the provided message when it is not
 * safe for server-side fetching.
 */
export const validateSafeServerFetchUrl = (
  raw: string | undefined,
  message: string,
): string | null => (raw && !isSafeServerFetchUrl(raw) ? message : null);
