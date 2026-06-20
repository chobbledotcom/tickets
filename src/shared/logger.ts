/**
 * Privacy-safe logging utilities
 *
 * - Request logging: logs method, path (slugs redacted), status, duration
 * - Error logging: logs classified error codes without PII
 * - Ntfy notifications: optional error pings to a configured ntfy URL
 * - Request IDs: each request gets a 4-char random ID prefix for log correlation
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { lazyRef } from "#fp";
import { logActivity } from "#shared/db/activityLog.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import {
  addPendingWork,
  hasPendingWorkScope,
  runWithPendingWork,
} from "#shared/pending-work.ts";

/** Request-scoped random ID for correlating log entries */
const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Module-level override for request log suppression.
 * Bypasses Deno.env to avoid races between parallel test workers.
 * When true/false, uses override; when null, reads from env.
 */
const [getSuppressOverride, setSuppressOverride] = lazyRef<boolean | null>(
  () => null,
);

/** Set module-level request log suppression (avoids env race in parallel tests). */
export const setSuppressRequestLogs = (value: boolean | null): void => {
  setSuppressOverride(value);
};

/** Check if request logs should be suppressed */
const shouldSuppressRequestLogs = (): boolean => {
  const override = getSuppressOverride();
  if (override !== null) return override;
  return !!Deno.env.get("TEST_SUPPRESS_REQUEST_LOGS");
};

/**
 * Module-level override for debug log suppression.
 * Bypasses Deno.env to avoid races between parallel test workers.
 */
const [getSuppressDebugOverride, setSuppressDebugOverride] = lazyRef<
  boolean | null
>(() => null);

/** Set module-level debug log suppression (avoids env race in parallel tests). */
export const setSuppressDebugLogs = (value: boolean | null): void => {
  setSuppressDebugOverride(value);
};

/** Check if debug logs should be suppressed */
const shouldSuppressDebugLogs = (): boolean => {
  const override = getSuppressDebugOverride();
  if (override !== null) return override;
  return !!Deno.env.get("TEST_SUPPRESS_DEBUG_LOGS");
};

/** Generate a 4-char lowercase hex string */
const generateRequestId = (): string => {
  const buf = crypto.getRandomValues(new Uint8Array(2));
  return new DataView(buf.buffer).getUint16(0).toString(16).padStart(4, "0");
};

/** Get the current request ID prefix, or empty string if outside request context */
const getLogPrefix = (): string => {
  const id = requestIdStorage.getStore();
  return id ? `[${id}] ` : "";
};

/** Get the current request ID, or empty string if outside request context */
export const getRequestId = (): string => requestIdStorage.getStore() ?? "";

/** Run a function with a request-scoped random ID for log correlation */
export const runWithRequestId = <T>(fn: () => T): T =>
  requestIdStorage.run(generateRequestId(), () => runWithPendingWork(fn));

/**
 * Error code definitions: each key maps to [wire code, human-readable label].
 * Single source of truth — ErrorCode and errorCodeLabel are derived from this.
 */
const ERROR_DEFS = {
  AUTH_CSRF_MISMATCH: ["E_AUTH_CSRF_MISMATCH", "CSRF mismatch"],
  AUTH_EXPIRED: ["E_AUTH_EXPIRED", "Session expired"],

  // Authentication errors
  AUTH_INVALID_SESSION: ["E_AUTH_INVALID_SESSION", "Invalid session"],
  AUTH_RATE_LIMITED: ["E_AUTH_RATE_LIMITED", "Rate limited"],

  // Botpoison spam-protection errors
  BOTPOISON_VERIFY: ["E_BOTPOISON_VERIFY", "Botpoison verification failed"],

  // Capacity/availability errors
  CAPACITY_EXCEEDED: ["E_CAPACITY_EXCEEDED", "Capacity exceeded"],

  // CDN/network errors (transient edge failures)
  CDN_REQUEST: ["E_CDN_REQUEST", "CDN request failed"],

  // Configuration errors
  CONFIG_MISSING: ["E_CONFIG_MISSING", "Configuration missing"],
  DATA_INVALID: ["E_DATA_INVALID", "Invalid data"],
  // Database errors
  DB_CONNECTION: ["E_DB_CONNECTION", "Database connection failed"],
  DB_QUERY: ["E_DB_QUERY", "Database query failed"],

  // Encryption/decryption errors
  DECRYPT_FAILED: ["E_DECRYPT_FAILED", "Decryption failed"],

  // Domain validation errors
  DOMAIN_REJECTED: ["E_DOMAIN_REJECTED", "Domain rejected"],

  // Email errors
  EMAIL_SEND: ["E_EMAIL_SEND", "Email send failed"],
  EMAIL_TEMPLATE_RENDER: [
    "E_EMAIL_TEMPLATE_RENDER",
    "Email template render failed",
  ],
  ENCRYPT_FAILED: ["E_ENCRYPT_FAILED", "Encryption failed"],
  KEY_DERIVATION: ["E_KEY_DERIVATION", "Key derivation failed"],
  NOT_FOUND_ATTENDEE: ["E_NOT_FOUND_ATTENDEE", "Attendee not found"],

  // Not found
  NOT_FOUND_LISTING: ["E_NOT_FOUND_LISTING", "Listing not found"],
  PAYMENT_CHECKOUT: ["E_PAYMENT_CHECKOUT", "Payment checkout failed"],
  PAYMENT_REFUND: ["E_PAYMENT_REFUND", "Payment refund failed"],
  PAYMENT_SESSION: ["E_PAYMENT_SESSION", "Payment session error"],

  // Payment provider errors (provider-agnostic)
  PAYMENT_SIGNATURE: [
    "E_PAYMENT_SIGNATURE",
    "Payment signature verification failed",
  ],
  PAYMENT_WEBHOOK_SETUP: [
    "E_PAYMENT_WEBHOOK_SETUP",
    "Payment webhook setup failed",
  ],
  SQUARE_CHECKOUT: ["E_SQUARE_CHECKOUT", "Square checkout failed"],
  SQUARE_ORDER: ["E_SQUARE_ORDER", "Square order validation failed"],
  SQUARE_REFUND: ["E_SQUARE_REFUND", "Square refund failed"],
  SQUARE_SESSION: ["E_SQUARE_SESSION", "Square session retrieval failed"],

  // Square-specific errors (used by square.ts internals)
  SQUARE_SIGNATURE: [
    "E_SQUARE_SIGNATURE",
    "Square signature verification failed",
  ],

  // Storage errors
  STORAGE_DELETE: ["E_STORAGE_DELETE", "Storage delete failed"],
  STORAGE_UPLOAD: ["E_STORAGE_UPLOAD", "Storage upload failed"],
  STRIPE_CHECKOUT: ["E_STRIPE_CHECKOUT", "Stripe checkout failed"],
  STRIPE_REFUND: ["E_STRIPE_REFUND", "Stripe refund failed"],
  STRIPE_SESSION: ["E_STRIPE_SESSION", "Stripe session retrieval failed"],

  // Stripe-specific errors (used by stripe.ts internals)
  STRIPE_SIGNATURE: [
    "E_STRIPE_SIGNATURE",
    "Stripe signature verification failed",
  ],
  STRIPE_WEBHOOK_SETUP: [
    "E_STRIPE_WEBHOOK_SETUP",
    "Stripe webhook setup failed",
  ],
  VALIDATION_CONTENT_TYPE: [
    "E_VALIDATION_CONTENT_TYPE",
    "Invalid content type",
  ],

  // Validation errors
  VALIDATION_FORM: ["E_VALIDATION_FORM", "Form validation error"],

  // Webhook errors
  WEBHOOK_PRICE_SIGNATURE: [
    "E_WEBHOOK_PRICE_SIGNATURE",
    "Webhook price signature invalid, missing, or charge differs from it",
  ],
  WEBHOOK_SEND: ["E_WEBHOOK_SEND", "Webhook send failed"],
} as const;

type ErrorDefs = typeof ERROR_DEFS;

/** Error code strings for use in logError calls */
export const ErrorCode: { [K in keyof ErrorDefs]: ErrorDefs[K][0] } =
  Object.fromEntries(
    Object.entries(ERROR_DEFS).map(([k, [code]]) => [k, code]),
  ) as { [K in keyof ErrorDefs]: ErrorDefs[K][0] };

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Human-readable labels for error codes (shown in admin activity log) */
export const errorCodeLabel: Record<ErrorCodeType, string> = Object.fromEntries(
  Object.values(ERROR_DEFS).map(([code, label]) => [code, label]),
) as Record<ErrorCodeType, string>;

/**
 * Redact dynamic segments from paths for privacy-safe logging
 * Replaces:
 * - /ticket/:slug -> /ticket/[redacted]
 * - /admin/listings/:id -> /admin/listings/[id]
 * - /admin/listings/:id/attendees/:aid -> /admin/listings/[id]/attendees/[id]
 */
export const redactPath = (path: string): string => {
  // Redact ticket slugs: /ticket/anything -> /ticket/[redacted]
  let redacted = path.replace(/^\/ticket\/[^/]+/, "/ticket/[redacted]");

  // Redact numeric IDs in admin paths: /admin/listings/123 -> /admin/listings/[id]
  redacted = redacted.replace(/\/(\d+)(\/|$)/g, "/[id]$2");

  // Redact tokens in wallet webservice paths:
  // /v1/devices/:device/registrations/:passType/:token → redact device + token
  // /v1/passes/:passType/:token → redact token
  redacted = redacted.replace(
    /^\/v1\/devices\/[^/]+/,
    "/v1/devices/[redacted]",
  );
  redacted = redacted.replace(
    /^\/v1\/passes\/([^/]+)\/[^/]+/,
    "/v1/passes/$1/[redacted]",
  );
  redacted = redacted.replace(
    /^\/v1\/devices\/\[redacted\]\/registrations\/([^/]+)\/[^/]+/,
    "/v1/devices/[redacted]/registrations/$1/[redacted]",
  );

  // Redact tokens in wallet download paths: /wallet/:token → redact token
  redacted = redacted.replace(/^\/wallet\/[^/]+/, "/wallet/[redacted]");

  // Redact tokens in checkin paths: /checkin/:token → redact token
  redacted = redacted.replace(/^\/checkin\/[^/]+/, "/checkin/[redacted]");

  return redacted;
};

/**
 * Request log entry (privacy-safe)
 */
type RequestLogEntry = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
};

/**
 * Log a completed request to console.debug
 * Path is automatically redacted for privacy
 */
export const logRequest = (entry: RequestLogEntry): void => {
  if (shouldSuppressRequestLogs()) return;
  const redactedPath = redactPath(entry.path);

  console.debug(
    `${getLogPrefix()}[Request] ${entry.method} ${redactedPath} ${entry.status} ${entry.durationMs}ms`,
  );
};

/**
 * Error log context (privacy-safe metadata only)
 */
export type ErrorContext = {
  /** Error code for classification */
  code: ErrorCodeType;
  /** Optional: listing ID (not slug) */
  listingId?: number;
  /** Optional: attendee ID */
  attendeeId?: number;
  /** Optional: additional safe context */
  detail?: string;
};

/** Format an error detail string with request context and error message */
export const formatRequestError = (
  method: string,
  path: string,
  error: unknown,
): string => {
  const msg = error instanceof Error ? error.message : String(error);
  return `${method} ${redactPath(path)}: ${msg}`;
};

/** Format an error context into a human-readable activity log message */
export const formatErrorMessage = (context: ErrorContext): string => {
  const label = errorCodeLabel[context.code];
  return context.detail
    ? `Error: ${label} (${context.detail})`
    : `Error: ${label}`;
};

/** Guard against recursive logError→logActivity→logError loops */
const errorPersistGuard = { active: false };

/** Persist error to activity log, swallowing failures to prevent cascading errors */
const persistErrorToActivityLog = async (
  context: ErrorContext,
): Promise<void> => {
  if (errorPersistGuard.active) return;
  errorPersistGuard.active = true;
  try {
    await logActivity(formatErrorMessage(context), context.listingId ?? null);
  } catch {
    // Swallow DB errors to avoid cascading failures
  } finally {
    errorPersistGuard.active = false;
  }
};

/**
 * Log a classified error to console.error only (no ntfy, no activity log).
 * Use this where calling logError would cause infinite recursion (e.g. ntfy.ts).
 */
export const logErrorLocal = (context: ErrorContext): void => {
  const parts = [
    `[Error] ${context.code}`,
    context.listingId !== undefined ? `listing=${context.listingId}` : null,
    context.attendeeId !== undefined ? `attendee=${context.attendeeId}` : null,
    context.detail ? `detail="${context.detail}"` : null,
  ].filter(Boolean);

  console.error(`${getLogPrefix()}${parts.join(" ")}`);
};

/**
 * Log a classified error to console.error and persist to the activity log.
 * Console output uses error codes and safe metadata (never PII).
 * Activity log entry is encrypted and visible to admins on the log pages.
 */
export const logError = (context: ErrorContext): void => {
  logErrorLocal(context);

  if (hasPendingWorkScope()) {
    addPendingWork(sendNtfyError(context.code));
    addPendingWork(persistErrorToActivityLog(context));
  }
};

/**
 * Run a non-critical follow-up write, logging any failure (under DB_QUERY) but
 * never throwing. Use it to isolate a bookkeeping/stats write from a critical
 * operation that has already succeeded — a sent text, or a charged order being
 * refunded — so a stats failure can neither report that success as a failure
 * nor block the refund. The failure is still surfaced to the error log so the
 * underlying data can be repaired.
 */
export const bestEffort = async (
  detail: string,
  op: () => Promise<void>,
): Promise<void> => {
  try {
    await op();
  } catch (error) {
    logError({ code: ErrorCode.DB_QUERY, detail: `${detail}: ${error}` });
  }
};

/**
 * Create a request timer for measuring duration
 */
export const createRequestTimer = (): (() => number) => {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
};

/**
 * Log categories for debug logging
 */
export type LogCategory =
  | "Setup"
  | "Webhook"
  | "Payment"
  | "Auth"
  | "Stripe"
  | "Square"
  | "SumUp"
  | "Domain"
  | "Email"
  | "Storage"
  | "Wallet"
  | "Migration"
  | "Prune";

/**
 * Log a debug message with category prefix
 * For detailed debugging during development
 */
export const logDebug = (category: LogCategory, message: string): void => {
  if (shouldSuppressDebugLogs()) return;
  console.debug(`${getLogPrefix()}[${category}] ${message}`);
};
