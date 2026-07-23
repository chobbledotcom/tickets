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
