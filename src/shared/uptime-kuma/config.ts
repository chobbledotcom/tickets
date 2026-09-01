import { isBuilderEnabled } from "#shared/config.ts";
import { getEnv } from "#shared/env.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";

const DEFAULT_UPTIME_KUMA_INTERVAL_MINUTES = 15;

const CREDENTIAL_KEYS = [
  "UPTIME_KUMA_URL",
  "UPTIME_KUMA_USERNAME",
  "UPTIME_KUMA_PASSWORD",
] as const;

export type UptimeKumaConfig = {
  intervalSeconds: number;
  password: string;
  url: string;
  username: string;
};

const nonBlank = (name: string, value: string): string => {
  if (value.trim().length === 0) throw new Error(`${name} must not be blank`);
  return value;
};

/** The first 16-bit group of a bracketed IPv6 host, or null for any host that
 * is not one. The URL parser has already rejected a bracketed host that is not
 * canonical IPv6, whose every group is hex. */
const ipv6FirstHextet = (hostname: string): number | null => {
  if (!hostname.startsWith("[")) return null;
  const to = hostname.indexOf(":");
  return to > 1 ? Number.parseInt(hostname.slice(1, to), 16) : null;
};

/** Hosts that may use cleartext http for the Kuma login: loopback, plus the
 * address ranges no packet can leave the operator's network for — private
 * blocks, CGNAT space where VPNs such as Tailscale live, and link-local. Any
 * other host needs HTTPS, so the Kuma password never crosses a public
 * network unencrypted. */
const isLocalHttpHost = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (hostname === "[::1]") return true;
  const octets = hostname.split(".").map(Number);
  const [first = -1, second = -1] = octets;
  // The URL constructor rejects a numeric host with an out-of-range octet, so
  // four integer labels here can only be a parsed IPv4 address.
  const isIpv4 = octets.length === 4 && octets.every(Number.isInteger);
  if (isIpv4) {
    return (
      first === 10 || // 10.0.0.0/8
      first === 127 || // 127.0.0.0/8
      (first === 100 && second >= 64 && second <= 127) || // 100.64.0.0/10
      (first === 169 && second === 254) || // 169.254.0.0/16
      (first === 172 && second >= 16 && second <= 31) || // 172.16.0.0/12
      (first === 192 && second === 168) // 192.168.0.0/16
    );
  }
  const hextet = ipv6FirstHextet(hostname);
  return (
    hextet !== null &&
    ((hextet & 0xfc00) === 0xfc00 || // fc00::/7 unique local
      (hextet & 0xffc0) === 0xfe80) // fe80::/10 link local
  );
};

const parseBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UPTIME_KUMA_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("UPTIME_KUMA_URL must use http or https");
  }
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
    throw new Error("UPTIME_KUMA_URL must use HTTPS outside a local network");
  }
  if (url.username || url.password) {
    throw new Error("UPTIME_KUMA_URL must not contain a username or password");
  }
  if (url.search || url.hash) {
    throw new Error("UPTIME_KUMA_URL must not contain a query or fragment");
  }
  return url.href.replace(/\/+$/, "");
};

const intervalSeconds = (): number => {
  const raw =
    getEnv("UPTIME_KUMA_INTERVAL_MINUTES") ??
    String(DEFAULT_UPTIME_KUMA_INTERVAL_MINUTES);
  const minutes = parsePositiveInt(raw);
  if (minutes === null) {
    throw new Error(
      "UPTIME_KUMA_INTERVAL_MINUTES must be a positive whole number",
    );
  }
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("UPTIME_KUMA_INTERVAL_MINUTES is too large");
  }
  return seconds;
};

/** Read the complete host-level Kuma configuration, or null when it is absent. */
export const getUptimeKumaConfigOrNull = (): UptimeKumaConfig | null => {
  const [rawUrl, rawUsername, rawPassword] = CREDENTIAL_KEYS.map((key) =>
    getEnv(key),
  );
  if (
    rawUrl === undefined &&
    rawUsername === undefined &&
    rawPassword === undefined &&
    getEnv("UPTIME_KUMA_INTERVAL_MINUTES") === undefined
  ) {
    return null;
  }
  if (
    rawUrl === undefined ||
    rawUsername === undefined ||
    rawPassword === undefined
  ) {
    throw new Error(
      "UPTIME_KUMA_URL, UPTIME_KUMA_USERNAME and UPTIME_KUMA_PASSWORD must all be set",
    );
  }
  return {
    intervalSeconds: intervalSeconds(),
    password: nonBlank("UPTIME_KUMA_PASSWORD", rawPassword),
    url: parseBaseUrl(nonBlank("UPTIME_KUMA_URL", rawUrl)),
    username: nonBlank("UPTIME_KUMA_USERNAME", rawUsername),
  };
};

/** Kuma management is available only on a configured builder instance. */
export const getEnabledUptimeKumaConfigOrNull = (): UptimeKumaConfig | null =>
  isBuilderEnabled() ? getUptimeKumaConfigOrNull() : null;

/** Fail at boot when an optional Kuma configuration is partial or malformed. */
export const validateUptimeKumaConfig = (): void => {
  getUptimeKumaConfigOrNull();
};
