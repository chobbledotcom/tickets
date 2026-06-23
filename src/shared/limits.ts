/**
 * Configurable system limits with environment variable overrides.
 *
 * Each limit has a sensible default. To override, set the corresponding
 * environment variable (parsed as a positive integer). Invalid or missing
 * env vars fall back to the default.
 */

import { getEnv } from "#shared/env.ts";

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

/**
 * Maximum number of database backups retained per database (default: 30).
 * When a new backup is created beyond this count, the oldest backups are
 * purged automatically. Backups accumulate otherwise, so this caps storage use.
 */
export const MAX_BACKUPS = readLimit("MAX_BACKUPS", 30);

// ---------------------------------------------------------------------------
// Text limits
// ---------------------------------------------------------------------------

/** Maximum textarea content length in characters (default: 10240 = 10KB) */
export const MAX_TEXTAREA_LENGTH = readLimit("MAX_TEXTAREA_LENGTH", 10_240);

/**
 * Maximum number of line items one attendee-form submission may declare
 * (default: 1000).
 *
 * The attendee add/edit form reads its repeated event-registration rows from
 * an operator-controlled `line_count`, looping once per declared line. Without
 * a ceiling a hand-crafted POST with `line_count=1e9` would spin the edge
 * worker allocating millions of blank line objects — a cheap denial of
 * service. The cap sits far above any realistic number of registrations on a
 * single attendee, so it never truncates a legitimate form.
 */
export const MAX_FORM_LINES = readLimit("MAX_FORM_LINES", 1000);

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

/**
 * CSRF token validity for the scanner check-in API in seconds.
 * Defaults to the session lifetime: admins keep the scanner page open for a
 * whole listing, so the embedded CSRF token should stay valid for as long as the
 * session that authenticates them — otherwise check-ins fail on CSRF expiry
 * while the admin is still logged in.
 */
export const SCANNER_CSRF_MAX_AGE_S = readLimit(
  "SCANNER_CSRF_MAX_AGE_S",
  SESSION_MAX_AGE_S,
);

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
// Token 404 rate limiting
// ---------------------------------------------------------------------------

/** Max distinct 404s on token URLs within the window before lockout (default: 5) */
export const MAX_TOKEN_404S = readLimit("MAX_TOKEN_404S", 5);

/** Sliding window for counting distinct 404s in ms (default: 60000 = 1 min) */
export const TOKEN_WINDOW_MS = readLimit("TOKEN_WINDOW_MS", 60 * 1000);

/** Lockout duration after max token 404s in ms (default: 300000 = 5 min) */
export const TOKEN_LOCKOUT_MS = readLimit("TOKEN_LOCKOUT_MS", 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Booking rate limiting
// ---------------------------------------------------------------------------

/** Max booking submissions per IP before lockout (default: 10) */
export const MAX_BOOKING_ATTEMPTS = readLimit("MAX_BOOKING_ATTEMPTS", 10);

/** Lockout duration after max booking submissions in ms (default: 600000 = 10 min) */
export const BOOKING_LOCKOUT_MS = readLimit(
  "BOOKING_LOCKOUT_MS",
  10 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// API-key (Bearer) auth rate limiting
// ---------------------------------------------------------------------------

/** Max failed API-key auth attempts per IP before lockout (default: 20) */
export const MAX_APIKEY_ATTEMPTS = readLimit("MAX_APIKEY_ATTEMPTS", 20);

/** Lockout duration after max failed API-key attempts in ms (default: 900000 = 15 min) */
export const APIKEY_LOCKOUT_MS = readLimit("APIKEY_LOCKOUT_MS", 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Database pruning
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The longest a payment provider keeps retrying a webhook before giving up
 * (Stripe and Square both retry for up to ~3 days). The processed_payments
 * idempotency row MUST outlive this window: if it is pruned while a retry can
 * still arrive, that retry re-processes the paid session and could re-issue a
 * refund. See prune.ts (prunePayments) and processed-payments.ts.
 */
export const WEBHOOK_RETRY_WINDOW_DAYS = 3;

/**
 * Validate the payments-retention config: reject a value that would let the
 * idempotency ledger be pruned while a provider could still retry the webhook.
 * Throws (failing startup) rather than silently risking a duplicate refund.
 * Extracted from the constant below so the invariant is unit-testable without
 * having to construct a broken live environment.
 */
export const assertPaymentsRetentionSafe = (days: number): number => {
  if (days < WEBHOOK_RETRY_WINDOW_DAYS) {
    throw new Error(
      `PRUNE_PAYMENTS_RETENTION_DAYS=${days} is below the ${WEBHOOK_RETRY_WINDOW_DAYS}-day ` +
        "provider webhook-retry window. A shorter retention can prune a payment's " +
        "idempotency row while the provider is still retrying its webhook, which would " +
        "re-process the session and risk a duplicate refund. Set it to at least " +
        `${WEBHOOK_RETRY_WINDOW_DAYS} (the default is 90).`,
    );
  }
  return days;
};

/** Retention (days) for resolved processed_payments rows (default: 90). Floored
 * at WEBHOOK_RETRY_WINDOW_DAYS so the idempotency ledger always outlives the
 * provider webhook-retry window (a too-short value throws at startup). */
export const PRUNE_PAYMENTS_RETENTION_DAYS = assertPaymentsRetentionSafe(
  readLimit("PRUNE_PAYMENTS_RETENTION_DAYS", 90),
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

/**
 * Retention (days) past last attempt for token_attempts rows (default: 7).
 * Kept short because the row is pure rate-limit bookkeeping — once the lockout
 * window has passed, retaining hashed-IP / hashed-token fingerprints serves
 * no anti-abuse purpose.
 */
export const PRUNE_TOKENS_RETENTION_DAYS = readLimit(
  "PRUNE_TOKENS_RETENTION_DAYS",
  7,
);

/**
 * Retention (hours) for sumup_checkouts staging rows (default: 24).
 * Kept very short because the row only exists to carry booking metadata from
 * checkout creation to payment completion: SumUp hosted checkouts expire after
 * 30 minutes and webhook retries stop after 2 hours, so nothing legitimate
 * reads the row after that.
 */
export const PRUNE_SUMUP_RETENTION_HOURS = readLimit(
  "PRUNE_SUMUP_RETENTION_HOURS",
  24,
);

/**
 * Retention (days) for encrypted string rows that have not been attached to an
 * attendee answer (default: 7). These are usually abandoned paid checkouts:
 * short-lived enough to avoid retaining free-text PII indefinitely, but long
 * enough to survive checkout lifetime plus delayed provider webhook retries.
 */
export const PRUNE_UNUSED_STRINGS_RETENTION_DAYS = readLimit(
  "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
  7,
);

/**
 * Retention (days) past last contact activity for contact_preferences rows
 * (default: 1825 = 5 years). Bounds the opaque repeat-customer recognition
 * table and makes loyalty status recency-bounded.
 */
export const PRUNE_CONTACTS_RETENTION_DAYS = readLimit(
  "PRUNE_CONTACTS_RETENTION_DAYS",
  1825,
);

/** How often (hours) to re-run each prune task (default: 24 = daily) */
export const PRUNE_INTERVAL_HOURS = readLimit("PRUNE_INTERVAL_HOURS", 24);

/**
 * Rows re-encrypted per activity-log backfill batch (default: 200). The whole
 * batch is written in one `executeBatch` (a single subrequest) after one SELECT,
 * so the per-request subrequest cost is fixed at two regardless of batch size.
 */
export const ACTIVITY_LOG_BACKFILL_BATCH = readLimit(
  "ACTIVITY_LOG_BACKFILL_BATCH",
  200,
);

/**
 * Minimum gap (seconds) between activity-log backfill batches (default: 60).
 * Throttles the fire-and-forget scheduler so one batch runs per minute of
 * traffic while draining, rather than once per request — fast enough to clear a
 * typical log within the hour, then it self-marks done and stops.
 */
export const ACTIVITY_LOG_BACKFILL_INTERVAL_MS =
  readLimit("ACTIVITY_LOG_BACKFILL_INTERVAL_SECONDS", 60) * 1000;

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

/** Maximum number of saved email templates (default: 1000) */
export const MAX_EMAIL_TEMPLATES = readLimit("MAX_EMAIL_TEMPLATES", 1000);

// ---------------------------------------------------------------------------
// Support form
// ---------------------------------------------------------------------------

/**
 * Days within which a repeat admin support-form submission is discouraged
 * (default: 7). After a submission the Support page shows a "you last submitted
 * this form …" notice for this long, to deter duplicate messages to the host.
 */
export const SUPPORT_FORM_NAG_DAYS = readLimit("SUPPORT_FORM_NAG_DAYS", 7);

/** Computed: prune interval in ms. */
export const PRUNE_INTERVAL_MS = PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;

/** Computed: retention windows in ms. */
export const PRUNE_PAYMENTS_RETENTION_MS =
  PRUNE_PAYMENTS_RETENTION_DAYS * DAY_MS;
export const PRUNE_SESSIONS_RETENTION_MS =
  PRUNE_SESSIONS_RETENTION_DAYS * DAY_MS;
export const PRUNE_LOGINS_RETENTION_MS = PRUNE_LOGINS_RETENTION_DAYS * DAY_MS;
export const PRUNE_TOKENS_RETENTION_MS = PRUNE_TOKENS_RETENTION_DAYS * DAY_MS;
export const PRUNE_SUMUP_RETENTION_MS =
  PRUNE_SUMUP_RETENTION_HOURS * 60 * 60 * 1000;
export const PRUNE_UNUSED_STRINGS_RETENTION_MS =
  PRUNE_UNUSED_STRINGS_RETENTION_DAYS * DAY_MS;
export const PRUNE_CONTACTS_RETENTION_MS =
  PRUNE_CONTACTS_RETENTION_DAYS * DAY_MS;

// ---------------------------------------------------------------------------
// Form re-fill stash
// ---------------------------------------------------------------------------

/**
 * How long (ms) submitted form values stay in the in-memory re-fill stash
 * (default: 15000 = 15s). Only needs to outlive a POST→redirect→GET round-trip
 * (a few ms), but is kept slightly longer than the flash cookie's own lifetime
 * so the values never expire before the message they accompany.
 */
export const FORM_STASH_TTL_MS = readLimit("FORM_STASH_TTL_MS", 15_000);

/**
 * Largest serialized form body (bytes) eligible for the re-fill stash
 * (default: 32768 = 32KB). Larger submissions skip the stash and fall back to
 * the cookie-only flash, bounding per-entry memory.
 */
export const FORM_STASH_MAX_BYTES = readLimit(
  "FORM_STASH_MAX_BYTES",
  32 * 1024,
);

/**
 * Maximum number of stashed form bodies retained at once (default: 100).
 * The oldest entries are evicted past this cap, so even a sustained burst of
 * failed submissions caps the stash at MAX_ENTRIES × MAX_BYTES (~3.2 MB) per
 * isolate; over-budget entries just fall back to the cookie-only flash.
 */
export const FORM_STASH_MAX_ENTRIES = readLimit("FORM_STASH_MAX_ENTRIES", 100);

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
  if (unit === "days") return `${value} days`;
  if (unit === "hours") return `${value} hours`;
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
    current: MAX_TEXTAREA_LENGTH,
    defaultValue: 10_240,
    envKey: "MAX_TEXTAREA_LENGTH",
    label: "Max textarea length",
    unit: "chars",
  },
  {
    current: MAX_FORM_LINES,
    defaultValue: 1000,
    envKey: "MAX_FORM_LINES",
    label: "Max attendee-form line items",
    unit: "lines",
  },
  {
    current: MAX_IMAGE_SIZE,
    defaultValue: 256 * 1024,
    envKey: "MAX_IMAGE_SIZE",
    label: "Max image size",
    unit: "bytes",
  },
  {
    current: MAX_ATTACHMENT_SIZE,
    defaultValue: 25 * 1024 * 1024,
    envKey: "MAX_ATTACHMENT_SIZE",
    label: "Max attachment size",
    unit: "bytes",
  },
  {
    current: MAX_BACKUPS,
    defaultValue: 30,
    envKey: "MAX_BACKUPS",
    label: "Max retained backups",
    unit: "backups",
  },
  {
    current: ATTACHMENT_URL_MAX_AGE_S,
    defaultValue: 3600,
    envKey: "ATTACHMENT_URL_MAX_AGE_S",
    label: "Attachment URL max age",
    unit: "seconds",
  },
  {
    current: SESSION_MAX_AGE_S,
    defaultValue: 60 * 60 * 24,
    envKey: "SESSION_MAX_AGE_S",
    label: "Session max age",
    unit: "seconds",
  },
  {
    current: SCANNER_CSRF_MAX_AGE_S,
    defaultValue: SESSION_MAX_AGE_S,
    envKey: "SCANNER_CSRF_MAX_AGE_S",
    label: "Scanner CSRF max age",
    unit: "seconds",
  },
  {
    current: STALE_RESERVATION_MS,
    defaultValue: 5 * 60 * 1000,
    envKey: "STALE_RESERVATION_MS",
    label: "Stale reservation threshold",
    unit: "ms",
  },
  {
    current: MAX_LOGIN_ATTEMPTS,
    defaultValue: 5,
    envKey: "MAX_LOGIN_ATTEMPTS",
    label: "Max login attempts",
    unit: "attempts",
  },
  {
    current: LOGIN_LOCKOUT_MS,
    defaultValue: 15 * 60 * 1000,
    envKey: "LOGIN_LOCKOUT_MS",
    label: "Login lockout duration",
    unit: "ms",
  },
  {
    current: MAX_TOKEN_404S,
    defaultValue: 5,
    envKey: "MAX_TOKEN_404S",
    label: "Max token 404s before lockout",
    unit: "attempts",
  },
  {
    current: TOKEN_WINDOW_MS,
    defaultValue: 60 * 1000,
    envKey: "TOKEN_WINDOW_MS",
    label: "Token 404 window",
    unit: "ms",
  },
  {
    current: TOKEN_LOCKOUT_MS,
    defaultValue: 5 * 60 * 1000,
    envKey: "TOKEN_LOCKOUT_MS",
    label: "Token lockout duration",
    unit: "ms",
  },
  {
    current: MAX_BOOKING_ATTEMPTS,
    defaultValue: 10,
    envKey: "MAX_BOOKING_ATTEMPTS",
    label: "Max booking attempts before lockout",
    unit: "attempts",
  },
  {
    current: BOOKING_LOCKOUT_MS,
    defaultValue: 10 * 60 * 1000,
    envKey: "BOOKING_LOCKOUT_MS",
    label: "Booking lockout duration",
    unit: "ms",
  },
  {
    current: MAX_APIKEY_ATTEMPTS,
    defaultValue: 20,
    envKey: "MAX_APIKEY_ATTEMPTS",
    label: "Max failed API-key attempts before lockout",
    unit: "attempts",
  },
  {
    current: APIKEY_LOCKOUT_MS,
    defaultValue: 15 * 60 * 1000,
    envKey: "APIKEY_LOCKOUT_MS",
    label: "API-key lockout duration",
    unit: "ms",
  },
  {
    current: PRUNE_PAYMENTS_RETENTION_DAYS,
    defaultValue: 90,
    envKey: "PRUNE_PAYMENTS_RETENTION_DAYS",
    label: "Prune: payments retention",
    unit: "days",
  },
  {
    current: PRUNE_SESSIONS_RETENTION_DAYS,
    defaultValue: 90,
    envKey: "PRUNE_SESSIONS_RETENTION_DAYS",
    label: "Prune: sessions retention",
    unit: "days",
  },
  {
    current: PRUNE_LOGINS_RETENTION_DAYS,
    defaultValue: 90,
    envKey: "PRUNE_LOGINS_RETENTION_DAYS",
    label: "Prune: login-attempts retention",
    unit: "days",
  },
  {
    current: PRUNE_TOKENS_RETENTION_DAYS,
    defaultValue: 7,
    envKey: "PRUNE_TOKENS_RETENTION_DAYS",
    label: "Prune: token-attempts retention",
    unit: "days",
  },
  {
    current: PRUNE_SUMUP_RETENTION_HOURS,
    defaultValue: 24,
    envKey: "PRUNE_SUMUP_RETENTION_HOURS",
    label: "Prune: SumUp checkout staging retention",
    unit: "hours",
  },
  {
    current: PRUNE_UNUSED_STRINGS_RETENTION_DAYS,
    defaultValue: 7,
    envKey: "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
    label: "Prune: unused encrypted strings retention",
    unit: "days",
  },
  {
    current: PRUNE_CONTACTS_RETENTION_DAYS,
    defaultValue: 1825,
    envKey: "PRUNE_CONTACTS_RETENTION_DAYS",
    label: "Prune: contact-preferences retention",
    unit: "days",
  },
  {
    current: PRUNE_INTERVAL_HOURS,
    defaultValue: 24,
    envKey: "PRUNE_INTERVAL_HOURS",
    label: "Prune: run interval",
    unit: "hours",
  },
  {
    current: FORM_STASH_TTL_MS,
    defaultValue: 15_000,
    envKey: "FORM_STASH_TTL_MS",
    label: "Form re-fill stash TTL",
    unit: "ms",
  },
  {
    current: FORM_STASH_MAX_BYTES,
    defaultValue: 32 * 1024,
    envKey: "FORM_STASH_MAX_BYTES",
    label: "Form re-fill stash max size",
    unit: "bytes",
  },
  {
    current: FORM_STASH_MAX_ENTRIES,
    defaultValue: 100,
    envKey: "FORM_STASH_MAX_ENTRIES",
    label: "Form re-fill stash max entries",
    unit: "entries",
  },
  {
    current: SUPPORT_FORM_NAG_DAYS,
    defaultValue: 7,
    envKey: "SUPPORT_FORM_NAG_DAYS",
    label: "Support form repeat-submit notice",
    unit: "days",
  },
  {
    current: MAX_EMAIL_TEMPLATES,
    defaultValue: 1000,
    envKey: "MAX_EMAIL_TEMPLATES",
    label: "Max saved email templates",
    unit: "templates",
  },
];
