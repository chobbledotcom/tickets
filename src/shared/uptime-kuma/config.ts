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

/** Hosts that can use cleartext http for the Kuma login. Loopback is one.
 * The rest are ranges no packet can leave the operator's network for. These
 * are the private blocks, the CGNAT space where VPNs such as Tailscale live,
 * and link-local. Every other host needs HTTPS, so the Kuma password never
 * crosses a public network unencrypted. */
const isLocalHttpHost = (rawHostname: string): boolean => {
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
