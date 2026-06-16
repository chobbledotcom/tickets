/**
 * SSRF guard for admin-supplied URLs that the server fetches itself
 * (currently a listing's webhook_url).
 *
 * Allows only https:// URLs to public hosts and rejects loopback, link-local,
 * private-range, and internal hostnames — including the cloud metadata address
 * 169.254.169.254. This is hostname-based and best-effort: it does not resolve
 * DNS, so it does not defend against DNS rebinding, but it blocks the obvious
 * "fetch an internal service" cases and forces TLS.
 */

/** Internal hostname suffixes/names that must never be fetched server-side. */
const isInternalHostname = (h: string): boolean =>
  h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal");

/** IPv6 literal loopback (::1), link-local (fe80::/10), or unique-local (fc00::/7). */
const isPrivateIpv6 = (h: string): boolean =>
  h === "::1" ||
  h.startsWith("fe80:") ||
  h.startsWith("fc") ||
  h.startsWith("fd");

/** IPv4 literal in a this-host / loopback / private / link-local / CGNAT range. */
const isPrivateIpv4 = (h: string): boolean => {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** True when a hostname (or IP literal) must never be fetched server-side. */
const isPrivateHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isInternalHostname(h)) return true;
  return h.includes(":") ? isPrivateIpv6(h) : isPrivateIpv4(h);
};

/**
 * True when `raw` is a safe URL for the server to fetch: a syntactically valid
 * https:// URL whose host is not internal/private.
 */
export const isSafeWebhookUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !isPrivateHost(url.hostname);
};
