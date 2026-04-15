/**
 * Configurable system limits with environment variable overrides.
 *
 * Each limit has a sensible default. To override, set the corresponding
 * environment variable (parsed as a positive integer). Invalid or missing
 * env vars fall back to the default.
 */

import { getEnv } from "#lib/env.ts";

/**
 * Parse a string as a positive integer, falling back to the given default
 * if the input is empty, non-numeric, or non-positive.
 */
export const parsePositiveInt = (raw: string, fallback: number): number => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read a limit from an env var with a fallback default.
 * Returns the env value when it parses to a positive integer, otherwise the default.
 */
export const readLimit = (envKey: string, defaultValue: number): number => {
  const raw = getEnv(envKey);
  if (raw === undefined) return defaultValue;
  return parsePositiveInt(raw, defaultValue);
};

// ---------------------------------------------------------------------------
// Storage limits
// ---------------------------------------------------------------------------

/** Maximum image file size in bytes (default: 256KB) */
export const MAX_IMAGE_SIZE = readLimit("MAX_IMAGE_SIZE", 256 * 1024);

/** Maximum attachment file size in bytes (default: 25MB) */
export const MAX_ATTACHMENT_SIZE = readLimit(
  "MAX_ATTACHMENT_SIZE",
  25 * 1024 * 1024,
);

// ---------------------------------------------------------------------------
// Text limits
// ---------------------------------------------------------------------------

/** Maximum textarea content length in characters (default: 10240 = 10KB) */
export const MAX_TEXTAREA_LENGTH = readLimit("MAX_TEXTAREA_LENGTH", 10_240);

// ---------------------------------------------------------------------------
// Timing limits
// ---------------------------------------------------------------------------

/** Signed attachment URL validity in seconds (default: 3600 = 1 hour) */
export const ATTACHMENT_URL_MAX_AGE_S = readLimit(
  "ATTACHMENT_URL_MAX_AGE_S",
  3600,
);

/** Admin session cookie max-age in seconds (default: 86400 = 24 hours) */
export const SESSION_MAX_AGE_S = readLimit("SESSION_MAX_AGE_S", 60 * 60 * 24);

/** Threshold for abandoned payment reservations in ms (default: 300000 = 5 min) */
export const STALE_RESERVATION_MS = readLimit(
  "STALE_RESERVATION_MS",
  5 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------

/** Max failed login attempts before lockout (default: 5) */
export const MAX_LOGIN_ATTEMPTS = readLimit("MAX_LOGIN_ATTEMPTS", 5);

/** Lockout duration after max failed logins in ms (default: 900000 = 15 min) */
export const LOGIN_LOCKOUT_MS = readLimit("LOGIN_LOCKOUT_MS", 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Database pruning
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention (days) for finalized processed_payments rows (default: 90) */
export const PRUNE_PAYMENTS_RETENTION_DAYS = readLimit(
  "PRUNE_PAYMENTS_RETENTION_DAYS",
  90,
);

/** Retention (days) past expiry for sessions rows (default: 90) */
export const PRUNE_SESSIONS_RETENTION_DAYS = readLimit(
  "PRUNE_SESSIONS_RETENTION_DAYS",
  90,
);

/** Retention (days) past lockout for login_attempts rows (default: 90) */
export const PRUNE_LOGINS_RETENTION_DAYS = readLimit(
  "PRUNE_LOGINS_RETENTION_DAYS",
  90,
);

/** How often (hours) to re-run each prune task (default: 24 = daily) */
export const PRUNE_INTERVAL_HOURS = readLimit("PRUNE_INTERVAL_HOURS", 24);

/** Computed: prune interval in ms. */
export const PRUNE_INTERVAL_MS = PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;

/** Computed: retention windows in ms. */
export const PRUNE_PAYMENTS_RETENTION_MS =
  PRUNE_PAYMENTS_RETENTION_DAYS * DAY_MS;
export const PRUNE_SESSIONS_RETENTION_MS =
  PRUNE_SESSIONS_RETENTION_DAYS * DAY_MS;
export const PRUNE_LOGINS_RETENTION_MS = PRUNE_LOGINS_RETENTION_DAYS * DAY_MS;

// ---------------------------------------------------------------------------
// Metadata for debug page display
// ---------------------------------------------------------------------------

/** Format bytes as a human-readable size string */
export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};

/** Format milliseconds as a human-readable duration string */
export const formatMs = (ms: number): string => {
  if (ms >= 60 * 60 * 1000) {
    const h = Math.round(ms / (60 * 60 * 1000));
    return `${h}h`;
  }
  if (ms >= 60 * 1000) {
    const m = Math.round(ms / (60 * 1000));
    return `${m}min`;
  }
  if (ms >= 1000) {
    const s = Math.round(ms / 1000);
    return `${s}s`;
  }
  return `${ms}ms`;
};

/** Format seconds as a human-readable duration string */
export const formatSeconds = (seconds: number): string => {
  if (seconds >= 86400) {
    const d = Math.round(seconds / 86400);
    return `${d}d`;
  }
  if (seconds >= 3600) {
    const h = Math.round(seconds / 3600);
    return `${h}h`;
  }
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m}min`;
  }
  return `${seconds}s`;
};

/** Format a limit value with its unit into a human-readable string */
export const formatLimitValue = (value: number, unit: string): string => {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "ms") return formatMs(value);
  if (unit === "seconds") return formatSeconds(value);
  if (unit === "chars") return `${value} chars`;
  if (unit === "days") return `${value} day${value === 1 ? "" : "s"}`;
  if (unit === "hours") return `${value} hour${value === 1 ? "" : "s"}`;
  return `${value} ${unit}`;
};

type LimitEntry = {
  readonly label: string;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly current: number;
  readonly unit: string;
};

export const LIMIT_ENTRIES: readonly LimitEntry[] = [
  {
    label: "Max textarea length",
    envKey: "MAX_TEXTAREA_LENGTH",
    defaultValue: 10_240,
    current: MAX_TEXTAREA_LENGTH,
    unit: "chars",
  },
  {
    label: "Max image size",
    envKey: "MAX_IMAGE_SIZE",
    defaultValue: 256 * 1024,
    current: MAX_IMAGE_SIZE,
    unit: "bytes",
  },
  {
    label: "Max attachment size",
    envKey: "MAX_ATTACHMENT_SIZE",
    defaultValue: 25 * 1024 * 1024,
    current: MAX_ATTACHMENT_SIZE,
    unit: "bytes",
  },
  {
    label: "Attachment URL max age",
    envKey: "ATTACHMENT_URL_MAX_AGE_S",
    defaultValue: 3600,
    current: ATTACHMENT_URL_MAX_AGE_S,
    unit: "seconds",
  },
  {
    label: "Session max age",
    envKey: "SESSION_MAX_AGE_S",
    defaultValue: 60 * 60 * 24,
    current: SESSION_MAX_AGE_S,
    unit: "seconds",
  },
  {
    label: "Stale reservation threshold",
    envKey: "STALE_RESERVATION_MS",
    defaultValue: 5 * 60 * 1000,
    current: STALE_RESERVATION_MS,
    unit: "ms",
  },
  {
    label: "Max login attempts",
    envKey: "MAX_LOGIN_ATTEMPTS",
    defaultValue: 5,
    current: MAX_LOGIN_ATTEMPTS,
    unit: "attempts",
  },
  {
    label: "Login lockout duration",
    envKey: "LOGIN_LOCKOUT_MS",
    defaultValue: 15 * 60 * 1000,
    current: LOGIN_LOCKOUT_MS,
    unit: "ms",
  },
  {
    label: "Prune: payments retention",
    envKey: "PRUNE_PAYMENTS_RETENTION_DAYS",
    defaultValue: 90,
    current: PRUNE_PAYMENTS_RETENTION_DAYS,
    unit: "days",
  },
  {
    label: "Prune: sessions retention",
    envKey: "PRUNE_SESSIONS_RETENTION_DAYS",
    defaultValue: 90,
    current: PRUNE_SESSIONS_RETENTION_DAYS,
    unit: "days",
  },
  {
    label: "Prune: login-attempts retention",
    envKey: "PRUNE_LOGINS_RETENTION_DAYS",
    defaultValue: 90,
    current: PRUNE_LOGINS_RETENTION_DAYS,
    unit: "days",
  },
  {
    label: "Prune: run interval",
    envKey: "PRUNE_INTERVAL_HOURS",
    defaultValue: 24,
    current: PRUNE_INTERVAL_HOURS,
    unit: "hours",
  },
];
