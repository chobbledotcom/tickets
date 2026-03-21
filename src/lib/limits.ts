/**
 * Configurable system limits with environment variable overrides.
 *
 * Each limit has a sensible default. To override, set the corresponding
 * environment variable (parsed as a positive integer). Invalid or missing
 * env vars fall back to the default.
 */

import { getEnv } from "#lib/env.ts";

/**
 * Read a limit from an env var with a fallback default.
 * Returns the env value when it parses to a positive integer, otherwise the default.
 */
export const readLimit = (envKey: string, defaultValue: number): number => {
  const raw = getEnv(envKey);
  if (raw === undefined) return defaultValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
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
// Metadata for debug page display
// ---------------------------------------------------------------------------

/** Format bytes as a human-readable size string */
export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
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
];
