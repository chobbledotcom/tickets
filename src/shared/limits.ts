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
// Limit registry — the single source of truth
// ---------------------------------------------------------------------------

type LimitEntry = {
  readonly label: string;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly current: number;
  readonly unit: string;
};

/**
 * The debug-page display list. Each call to {@link limit} /
 * {@link computedLimit} appends one entry, so the table is derived from the
 * same declaration as the named constants — they can never drift. */
const REGISTRY: LimitEntry[] = [];

/** Register a computed limit whose value is derived from another limit (e.g.
 * `SCANNER_CSRF_MAX_AGE_S` defaults to `SESSION_MAX_AGE_S`, or
 * `PRUNE_PAYMENTS_RETENTION_DAYS` goes through `assertPaymentsRetentionSafe`).
 * Records its metadata for the debug table and returns the value. */
const computedLimit = (
  current: number,
  defaultValue: number,
  envKey: string,
  label: string,
  unit: string,
): number => {
  REGISTRY.push({ current, defaultValue, envKey, label, unit });
  return current;
};

/** Declare a tunable limit: read from env with `defaultValue`, register its
 * metadata, and return the resolved value. Each limit is declared exactly
 * once — the named export AND the {@link LIMIT_ENTRIES} debug table both
 * reference this single declaration, eliminating the dual-declaration drift
 * that previously let `MAX_IMAGE_SIZE` disagree (32 MB constant vs 256 KB
 * table entry). A plain env-read limit is just a computed one whose value comes
 * from {@link readLimit}, so it shares that registration path. */
const limit = (
  envKey: string,
  defaultValue: number,
  label: string,
  unit: string,
): number =>
  computedLimit(
    readLimit(envKey, defaultValue),
    defaultValue,
    envKey,
    label,
    unit,
  );

// ---------------------------------------------------------------------------
// Storage limits
// ---------------------------------------------------------------------------

/** Maximum image file size in bytes (default: 32MB) */
export const MAX_IMAGE_SIZE = limit(
  "MAX_IMAGE_SIZE",
  32 * 1024 * 1024,
  "Max image size",
  "bytes",
);

/** Maximum attachment file size in bytes (default: 25MB) */
export const MAX_ATTACHMENT_SIZE = limit(
  "MAX_ATTACHMENT_SIZE",
  25 * 1024 * 1024,
  "Max attachment size",
  "bytes",
);

/**
 * Maximum number of database backups retained per database (default: 30).
 * When a new backup is created beyond this count, the oldest backups are
 * purged automatically. Backups accumulate otherwise, so this caps storage use.
 */
export const MAX_BACKUPS = limit(
  "MAX_BACKUPS",
  30,
  "Max retained backups",
  "backups",
);

// ---------------------------------------------------------------------------
// Text limits
// ---------------------------------------------------------------------------

/** Maximum textarea content length in characters (default: 10240 = 10KB) */
export const MAX_TEXTAREA_LENGTH = limit(
  "MAX_TEXTAREA_LENGTH",
  10_240,
  "Max textarea length",
  "chars",
);

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
export const MAX_FORM_LINES = limit(
  "MAX_FORM_LINES",
  1000,
  "Max attendee-form line items",
  "lines",
);

// ---------------------------------------------------------------------------
// Timing limits
// ---------------------------------------------------------------------------

/** Signed attachment URL validity in seconds (default: 3600 = 1 hour) */
export const ATTACHMENT_URL_MAX_AGE_S = limit(
  "ATTACHMENT_URL_MAX_AGE_S",
  3600,
  "Attachment URL max age",
  "seconds",
);

/** Admin session cookie max-age in seconds (default: 86400 = 24 hours) */
export const SESSION_MAX_AGE_S = limit(
  "SESSION_MAX_AGE_S",
  60 * 60 * 24,
  "Session max age",
  "seconds",
);

/**
 * CSRF token validity for the scanner check-in API in seconds.
 * Defaults to the session lifetime: admins keep the scanner page open for a
 * whole listing, so the embedded CSRF token should stay valid for as long as the
 * session that authenticates them — otherwise check-ins fail on CSRF expiry
 * while the admin is still logged in.
 */
export const SCANNER_CSRF_MAX_AGE_S = computedLimit(
  readLimit("SCANNER_CSRF_MAX_AGE_S", SESSION_MAX_AGE_S),
  SESSION_MAX_AGE_S,
  "SCANNER_CSRF_MAX_AGE_S",
  "Scanner CSRF max age",
  "seconds",
);

/** Threshold for abandoned payment reservations in ms (default: 300000 = 5 min) */
export const STALE_RESERVATION_MS = limit(
  "STALE_RESERVATION_MS",
  5 * 60 * 1000,
  "Stale reservation threshold",
  "ms",
);

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------

/** Max failed login attempts before lockout (default: 5) */
export const MAX_LOGIN_ATTEMPTS = limit(
  "MAX_LOGIN_ATTEMPTS",
  5,
  "Max login attempts",
  "attempts",
);

/** Lockout duration after max failed logins in ms (default: 900000 = 15 min) */
export const LOGIN_LOCKOUT_MS = limit(
  "LOGIN_LOCKOUT_MS",
  15 * 60 * 1000,
  "Login lockout duration",
  "ms",
);

// ---------------------------------------------------------------------------
// Token 404 rate limiting
// ---------------------------------------------------------------------------

/** Max distinct 404s on token URLs within the window before lockout (default: 5) */
export const MAX_TOKEN_404S = limit(
  "MAX_TOKEN_404S",
  5,
  "Max token 404s before lockout",
  "attempts",
);

/** Sliding window for counting distinct 404s in ms (default: 60000 = 1 min) */
export const TOKEN_WINDOW_MS = limit(
  "TOKEN_WINDOW_MS",
  60 * 1000,
  "Token 404 window",
  "ms",
);

/** Lockout duration after max token 404s in ms (default: 300000 = 5 min) */
export const TOKEN_LOCKOUT_MS = limit(
  "TOKEN_LOCKOUT_MS",
  5 * 60 * 1000,
  "Token lockout duration",
  "ms",
);

// ---------------------------------------------------------------------------
// Booking rate limiting
// ---------------------------------------------------------------------------

/** Max booking submissions per IP before lockout (default: 10) */
export const MAX_BOOKING_ATTEMPTS = limit(
  "MAX_BOOKING_ATTEMPTS",
  10,
  "Max booking attempts before lockout",
  "attempts",
);

/** Lockout duration after max booking submissions in ms (default: 600000 = 10 min) */
export const BOOKING_LOCKOUT_MS = limit(
  "BOOKING_LOCKOUT_MS",
  10 * 60 * 1000,
  "Booking lockout duration",
  "ms",
);

// ---------------------------------------------------------------------------
// Address lookup (postcode search)
// ---------------------------------------------------------------------------

/** Max address lookups per IP before lockout (default: 30) */
export const MAX_ADDRESS_LOOKUPS = limit(
  "MAX_ADDRESS_LOOKUPS",
  30,
  "Max address lookups before lockout",
  "attempts",
);

/** Lockout duration after max address lookups in ms (default: 600000 = 10 min) */
export const ADDRESS_LOOKUP_LOCKOUT_MS = limit(
  "ADDRESS_LOOKUP_LOCKOUT_MS",
  10 * 60 * 1000,
  "Address lookup lockout duration",
  "ms",
);

// ---------------------------------------------------------------------------
// API-key (Bearer) auth rate limiting
// ---------------------------------------------------------------------------

/** Max failed API-key auth attempts per IP before lockout (default: 20) */
export const MAX_APIKEY_ATTEMPTS = limit(
  "MAX_APIKEY_ATTEMPTS",
  20,
  "Max failed API-key attempts before lockout",
  "attempts",
);

/** Lockout duration after max failed API-key attempts in ms (default: 900000 = 15 min) */
export const APIKEY_LOCKOUT_MS = limit(
  "APIKEY_LOCKOUT_MS",
  15 * 60 * 1000,
  "API-key lockout duration",
  "ms",
);

// ---------------------------------------------------------------------------
// Database pruning
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The longest a payment provider keeps retrying a webhook before giving up
 * (Stripe and Square both retry for up to ~3 days). Processed payment rows that
 * no longer carry useful refund references MUST outlive this window: pruning one
 * while a retry can still arrive could re-process the paid session and re-issue
 * a refund. Rows still needed for admin refunds are kept longer by prunePayments.
 */
export const WEBHOOK_RETRY_WINDOW_DAYS = 3;

/**
 * Validate the payments-retention config: reject a value that would let the
 * payment replay rows be pruned while a provider could still retry the webhook.
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
 * at WEBHOOK_RETRY_WINDOW_DAYS so payment replay rows always outlive the provider
 * webhook-retry window (a too-short value throws at startup). */
export const PRUNE_PAYMENTS_RETENTION_DAYS = computedLimit(
  assertPaymentsRetentionSafe(readLimit("PRUNE_PAYMENTS_RETENTION_DAYS", 90)),
  90,
  "PRUNE_PAYMENTS_RETENTION_DAYS",
  "Prune: payments retention",
  "days",
);

/** Retention (days) past expiry for sessions rows (default: 90) */
export const PRUNE_SESSIONS_RETENTION_DAYS = limit(
  "PRUNE_SESSIONS_RETENTION_DAYS",
  90,
  "Prune: sessions retention",
  "days",
);

/** Retention (days) past lockout for login_attempts rows (default: 90) */
export const PRUNE_LOGINS_RETENTION_DAYS = limit(
  "PRUNE_LOGINS_RETENTION_DAYS",
  90,
  "Prune: login-attempts retention",
  "days",
);

/**
 * Retention (days) past last attempt for token_attempts rows (default: 7).
 * Kept short because the row is pure rate-limit bookkeeping — once the lockout
 * window has passed, retaining hashed-IP / hashed-token fingerprints serves
 * no anti-abuse purpose.
 */
export const PRUNE_TOKENS_RETENTION_DAYS = limit(
  "PRUNE_TOKENS_RETENTION_DAYS",
  7,
  "Prune: token-attempts retention",
  "days",
);

/**
 * Retention (hours) for sumup_checkouts staging rows (default: 24).
 * Kept very short because the row only exists to carry booking metadata from
 * checkout creation to payment completion: SumUp hosted checkouts expire after
 * 30 minutes and webhook retries stop after 2 hours, so nothing legitimate
 * reads the row after that.
 */
export const PRUNE_SUMUP_RETENTION_HOURS = limit(
  "PRUNE_SUMUP_RETENTION_HOURS",
  24,
  "Prune: SumUp checkout staging retention",
  "hours",
);

/** Retention (days) for unpaid quantity-zero checkout stages (default: 7).
 * Provider callbacks after cleanup use the normal no-stage booking path.
 * Stages only need to outlive the longest completable checkout — Stripe
 * sessions expire after CHECKOUT_SESSION_EXPIRY_MINUTES and SumUp's after 30
 * minutes, so a Stripe/SumUp-only deployment can safely lower this to 1 day.
 * Square payment links never expire, so the default stays a conservative 7.
 * Keep PRUNE_UNUSED_STRINGS_RETENTION_DAYS at least this long too, or a very
 * late completion books fine but loses its free-text answers. */
export const PRUNE_CHECKOUT_STAGES_RETENTION_DAYS = limit(
  "PRUNE_CHECKOUT_STAGES_RETENTION_DAYS",
  7,
  "Prune: pending checkout stage retention",
  "days",
);

/**
 * Stripe rejects a checkout expiry outside 30 minutes–24 hours, judged by
 * STRIPE'S clock when the request arrives — so the configurable range keeps a
 * five-minute buffer inside both ends, or clock skew plus request latency
 * could push an exact-boundary value out of range and fail every checkout.
 * Checked at startup rather than on the first customer's checkout.
 */
export const assertCheckoutExpiryValid = (minutes: number): number => {
  if (minutes < 35 || minutes > 24 * 60 - 5) {
    throw new Error(
      `CHECKOUT_SESSION_EXPIRY_MINUTES=${minutes} must be between 35 and 1435 ` +
        "(Stripe allows 30 minutes to 24 hours, and a five-minute buffer " +
        "inside each end absorbs clock skew).",
    );
  }
  return minutes;
};

/**
 * How long a hosted Stripe checkout stays payable (minutes, default 60),
 * applied as the session's expiry when it is created. After expiry the hosted
 * page cannot complete and Stripe sends checkout.session.expired, which
 * discards the staged details straight away. SumUp checkouts expire themselves
 * at 30 minutes; Square payment links take no expiry and rely on the stage
 * pruner alone.
 */
export const CHECKOUT_SESSION_EXPIRY_MINUTES = computedLimit(
  assertCheckoutExpiryValid(readLimit("CHECKOUT_SESSION_EXPIRY_MINUTES", 60)),
  60,
  "CHECKOUT_SESSION_EXPIRY_MINUTES",
  "Checkout: Stripe session expiry",
  "minutes",
);

/**
 * Retention (days) for encrypted string rows that have not been attached to an
 * attendee answer (default: 7). These are usually abandoned paid checkouts:
 * short-lived enough to avoid retaining free-text PII indefinitely, but long
 * enough to survive checkout lifetime plus delayed provider webhook retries.
 */
export const PRUNE_UNUSED_STRINGS_RETENTION_DAYS = limit(
  "PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
  7,
  "Prune: unused encrypted strings retention",
  "days",
);

/**
 * Retention (days) past last contact activity for contact_preferences rows
 * (default: 1825 = 5 years). Bounds the opaque repeat-customer recognition
 * table and makes loyalty status recency-bounded.
 */
export const PRUNE_CONTACTS_RETENTION_DAYS = limit(
  "PRUNE_CONTACTS_RETENTION_DAYS",
  1825,
  "Prune: contact-preferences retention",
  "days",
);

/**
 * How long (days) a cached address-lookup result stays servable (default: 90).
 * A stale-but-unpruned row is never served: reads filter on the same cutoff
 * the prune task deletes by.
 */
export const ADDRESS_CACHE_DAYS = limit(
  "ADDRESS_CACHE_DAYS",
  90,
  "Address lookup cache retention",
  "days",
);

/** How often (hours) to re-run each prune task (default: 24 = daily) */
export const PRUNE_INTERVAL_HOURS = limit(
  "PRUNE_INTERVAL_HOURS",
  24,
  "Prune: run interval",
  "hours",
);

/**
 * Rows re-encrypted per activity-log backfill batch (default: 200). The whole
 * batch is written in one `executeBatch` (a single subrequest) after one SELECT,
 * so the per-request subrequest cost is fixed at two regardless of batch size.
 */
export const ACTIVITY_LOG_BACKFILL_BATCH = limit(
  "ACTIVITY_LOG_BACKFILL_BATCH",
  200,
  "Activity-log backfill batch size",
  "rows",
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
export const MAX_EMAIL_TEMPLATES = limit(
  "MAX_EMAIL_TEMPLATES",
  1000,
  "Max saved email templates",
  "templates",
);

// ---------------------------------------------------------------------------
// Support form
// ---------------------------------------------------------------------------

/**
 * Days within which a repeat admin support-form submission is discouraged
 * (default: 7). After a submission the Support page shows a "you last submitted
 * this form …" notice for this long, to deter duplicate messages to the host.
 */
export const SUPPORT_FORM_NAG_DAYS = limit(
  "SUPPORT_FORM_NAG_DAYS",
  7,
  "Support form repeat-submit notice",
  "days",
);

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
export const PRUNE_CHECKOUT_STAGES_RETENTION_MS =
  PRUNE_CHECKOUT_STAGES_RETENTION_DAYS * DAY_MS;
export const PRUNE_UNUSED_STRINGS_RETENTION_MS =
  PRUNE_UNUSED_STRINGS_RETENTION_DAYS * DAY_MS;
export const PRUNE_CONTACTS_RETENTION_MS =
  PRUNE_CONTACTS_RETENTION_DAYS * DAY_MS;
export const ADDRESS_CACHE_MS = ADDRESS_CACHE_DAYS * DAY_MS;

// ---------------------------------------------------------------------------
// Form re-fill stash
// ---------------------------------------------------------------------------

/**
 * How long (ms) submitted form values stay in the in-memory re-fill stash
 * (default: 15000 = 15s). Only needs to outlive a POST→redirect→GET round-trip
 * (a few ms), but is kept slightly longer than the flash cookie's own lifetime
 * so the values never expire before the message they accompany.
 */
export const FORM_STASH_TTL_MS = limit(
  "FORM_STASH_TTL_MS",
  15_000,
  "Form re-fill stash TTL",
  "ms",
);

/**
 * Largest serialized form body (bytes) eligible for the re-fill stash
 * (default: 32768 = 32KB). Larger submissions skip the stash and fall back to
 * the cookie-only flash, bounding per-entry memory.
 */
export const FORM_STASH_MAX_BYTES = limit(
  "FORM_STASH_MAX_BYTES",
  32 * 1024,
  "Form re-fill stash max size",
  "bytes",
);

/**
 * Maximum number of stashed form bodies retained at once (default: 100).
 * The oldest entries are evicted past this cap, so even a sustained burst of
 * failed submissions caps the stash at MAX_ENTRIES × MAX_BYTES (~3.2 MB) per
 * isolate; over-budget entries just fall back to the cookie-only flash.
 */
export const FORM_STASH_MAX_ENTRIES = limit(
  "FORM_STASH_MAX_ENTRIES",
  100,
  "Form re-fill stash max entries",
  "entries",
);

// ---------------------------------------------------------------------------
// Debug page display
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

/** The debug-page display list, derived from the limit declarations above. */
export const LIMIT_ENTRIES: readonly LimitEntry[] = REGISTRY;
