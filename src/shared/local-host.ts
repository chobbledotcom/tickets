/** Hosts that can use cleartext http for a credential-carrying request.
 * Loopback is one. The rest are ranges no packet can leave the operator's
 * network for: the private blocks, the CGNAT space where VPNs such as
 * Tailscale live, and link-local. Every other host needs HTTPS, so a bearer
 * token never crosses a public network unencrypted. */

/** The first 16-bit group of a bracketed IPv6 host, or null for any host that
 * is not one. The URL parser already rejects a bracketed host that is not
 * canonical IPv6. Every group of a canonical host is hex. */
const ipv6FirstGroup = (hostname: string): number | null => {
  if (!hostname.startsWith("[")) return null;
  const to = hostname.indexOf(":");
  return to > 1 ? Number.parseInt(hostname.slice(1, to), 16) : null;
};

/** A fully qualified name keeps one trailing root dot. "localhost." is still
 * the name "localhost". */
const withoutRootDot = (hostname: string): string =>
  hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;

/** True for an IPv4 host inside a range no packet can leave the operator's
 * network for. That covers loopback, the private blocks, CGNAT, and
 * link-local. */
const isLocalIpv4 = (hostname: string): boolean => {
  // A real IPv4 host arrives in canonical dotted decimal, digits only. A
  // lookalike DNS name such as "10.0.0.1e0" must not reach the octet
  // checks. Number("1e0") is 1, so only digit labels can pass.
  const labels = hostname.split(".");
  const isIpv4 =
    labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label));
  if (!isIpv4) return false;
  const first = Number(labels[0]!);
  const second = Number(labels[1]!);
  return (
    first === 10 || // 10.0.0.0/8
    first === 127 || // 127.0.0.0/8
    (first === 100 && second >= 64 && second <= 127) || // 100.64.0.0/10
    (first === 169 && second === 254) || // 169.254.0.0/16
    (first === 172 && second >= 16 && second <= 31) || // 172.16.0.0/12
    (first === 192 && second === 168) // 192.168.0.0/16
  );
};

export const isLocalHttpHost = (rawHostname: string): boolean => {
  const hostname = withoutRootDot(rawHostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname === "[::1]") return true;
  if (isLocalIpv4(hostname)) return true;
  const firstGroup = ipv6FirstGroup(hostname);
  return (
    firstGroup !== null &&
    ((firstGroup & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (firstGroup & 0xffc0) === 0xfe80) // fe80::/10 link local
  );
};
