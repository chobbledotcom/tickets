/**
 * Privacy-safe logging utilities
 *
 * - Request logging: logs method, path (slugs redacted), status, duration
 * - Error logging: logs classified error codes without PII
 * - Ntfy notifications: optional error pings to a configured ntfy URL
 * - Request IDs: each request gets a 4-char random ID prefix for log correlation
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logActivity } from "#lib/db/activityLog.ts";
import { sendNtfyError } from "#lib/ntfy.ts";
import { addPendingWork, runWithPendingWork } from "#lib/pending-work.ts";

/** Request-scoped random ID for correlating log entries */
const requestIdStorage = new AsyncLocalStorage<string>();

/** Generate a 4-char lowercase hex string */
const generateRequestId = (): string => {
  const n = crypto.getRandomValues(new Uint8Array(2));
  return ((n[0]! << 8) | n[1]!).toString(16).padStart(4, "0");
};

/** Get the current request ID prefix, or empty string if outside request context */
const getLogPrefix = (): string => {
  const id = requestIdStorage.getStore();
  return id ? `[${id}] ` : "";
};

/** Run a function with a request-scoped random ID for log correlation */
export const runWithRequestId = <T>(fn: () => T): T =>
  requestIdStorage.run(generateRequestId(), () => runWithPendingWork(fn));

/**
 * Error code definitions: each key maps to [wire code, human-readable label].
 * Single source of truth — ErrorCode and errorCodeLabel are derived from this.
 */
const ERROR_DEFS = {
  // Database errors
  DB_CONNECTION: ["E_DB_CONNECTION", "Database connection failed"],
  DB_QUERY: ["E_DB_QUERY", "Database query failed"],

  // Capacity/availability errors
  CAPACITY_EXCEEDED: ["E_CAPACITY_EXCEEDED", "Capacity exceeded"],

  // Encryption/decryption errors
  DECRYPT_FAILED: ["E_DECRYPT_FAILED", "Decryption failed"],
  ENCRYPT_FAILED: ["E_ENCRYPT_FAILED", "Encryption failed"],
  KEY_DERIVATION: ["E_KEY_DERIVATION", "Key derivation failed"],

  // Authentication errors
  AUTH_INVALID_SESSION: ["E_AUTH_INVALID_SESSION", "Invalid session"],
  AUTH_EXPIRED: ["E_AUTH_EXPIRED", "Session expired"],
  AUTH_CSRF_MISMATCH: ["E_AUTH_CSRF_MISMATCH", "CSRF mismatch"],
  AUTH_RATE_LIMITED: ["E_AUTH_RATE_LIMITED", "Rate limited"],

  // Payment provider errors (provider-agnostic)
  PAYMENT_SIGNATURE: ["E_PAYMENT_SIGNATURE", "Payment signature verification failed"],
  PAYMENT_SESSION: ["E_PAYMENT_SESSION", "Payment session error"],
  PAYMENT_REFUND: ["E_PAYMENT_REFUND", "Payment refund failed"],
  PAYMENT_CHECKOUT: ["E_PAYMENT_CHECKOUT", "Payment checkout failed"],
  PAYMENT_WEBHOOK_SETUP: ["E_PAYMENT_WEBHOOK_SETUP", "Payment webhook setup failed"],

  // Stripe-specific errors (used by stripe.ts internals)
  STRIPE_SIGNATURE: ["E_STRIPE_SIGNATURE", "Stripe signature verification failed"],
  STRIPE_SESSION: ["E_STRIPE_SESSION", "Stripe session retrieval failed"],
  STRIPE_REFUND: ["E_STRIPE_REFUND", "Stripe refund failed"],
  STRIPE_CHECKOUT: ["E_STRIPE_CHECKOUT", "Stripe checkout failed"],
  STRIPE_WEBHOOK_SETUP: ["E_STRIPE_WEBHOOK_SETUP", "Stripe webhook setup failed"],

  // Square-specific errors (used by square.ts internals)
  SQUARE_SIGNATURE: ["E_SQUARE_SIGNATURE", "Square signature verification failed"],
  SQUARE_SESSION: ["E_SQUARE_SESSION", "Square session retrieval failed"],
  SQUARE_REFUND: ["E_SQUARE_REFUND", "Square refund failed"],
  SQUARE_CHECKOUT: ["E_SQUARE_CHECKOUT", "Square checkout failed"],
  SQUARE_ORDER: ["E_SQUARE_ORDER", "Square order validation failed"],

  // Validation errors
  VALIDATION_FORM: ["E_VALIDATION_FORM", "Form validation error"],
  VALIDATION_CONTENT_TYPE: ["E_VALIDATION_CONTENT_TYPE", "Invalid content type"],
  DATA_INVALID: ["E_DATA_INVALID", "Invalid data"],

  // Storage errors
  STORAGE_DELETE: ["E_STORAGE_DELETE", "Storage delete failed"],

  // Webhook errors
  WEBHOOK_SEND: ["E_WEBHOOK_SEND", "Webhook send failed"],

  // Email errors
  EMAIL_SEND: ["E_EMAIL_SEND", "Email send failed"],

  // Not found
  NOT_FOUND_EVENT: ["E_NOT_FOUND_EVENT", "Event not found"],
  NOT_FOUND_ATTENDEE: ["E_NOT_FOUND_ATTENDEE", "Attendee not found"],

  // Configuration errors
  CONFIG_MISSING: ["E_CONFIG_MISSING", "Configuration missing"],

  // Domain validation errors
  DOMAIN_REJECTED: ["E_DOMAIN_REJECTED", "Domain rejected"],

  // CDN/network errors (transient edge failures)
  CDN_REQUEST: ["E_CDN_REQUEST", "CDN request failed"],
} as const;

type ErrorDefs = typeof ERROR_DEFS;

/** Error code strings for use in logError calls */
export const ErrorCode: { [K in keyof ErrorDefs]: ErrorDefs[K][0] } =
  Object.fromEntries(
    Object.entries(ERROR_DEFS).map(([k, [code]]) => [k, code]),
  ) as { [K in keyof ErrorDefs]: ErrorDefs[K][0] };

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Human-readable labels for error codes (shown in admin activity log) */
export const errorCodeLabel: Record<ErrorCodeType, string> =
  Object.fromEntries(
    Object.values(ERROR_DEFS).map(([code, label]) => [code, label]),
  ) as Record<ErrorCodeType, string>;

/**
 * Redact dynamic segments from paths for privacy-safe logging
 * Replaces:
 * - /ticket/:slug -> /ticket/[redacted]
 * - /admin/events/:id -> /admin/events/[id]
 * - /admin/events/:id/attendees/:aid -> /admin/events/[id]/attendees/[id]
 */
export const redactPath = (path: string): string => {
  // Redact ticket slugs: /ticket/anything -> /ticket/[redacted]
  let redacted = path.replace(/^\/ticket\/[^/]+/, "/ticket/[redacted]");

  // Redact numeric IDs in admin paths: /admin/events/123 -> /admin/events/[id]
  redacted = redacted.replace(/\/(\d+)(\/|$)/g, "/[id]$2");

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
  if (Deno.env.get("TEST_SUPPRESS_REQUEST_LOGS")) return;
  const { method, path, status, durationMs } = entry;
  const redactedPath = redactPath(path);

  // biome-ignore lint/suspicious/noConsole: Intentional debug logging
  console.debug(
    `${getLogPrefix()}[Request] ${method} ${redactedPath} ${status} ${durationMs}ms`,
  );
};

/**
 * Error log context (privacy-safe metadata only)
 */
export type ErrorContext = {
  /** Error code for classification */
  code: ErrorCodeType;
  /** Optional: event ID (not slug) */
  eventId?: number;
  /** Optional: attendee ID */
  attendeeId?: number;
  /** Optional: additional safe context */
  detail?: string;
};

/** Format an error context into a human-readable activity log message */
export const formatErrorMessage = (context: ErrorContext): string => {
  const label = errorCodeLabel[context.code];
  return context.detail ? `Error: ${label} (${context.detail})` : `Error: ${label}`;
};

/** Guard against recursive logError→logActivity→logError loops */
const errorPersistGuard = { active: false };

/** Persist error to activity log, swallowing failures to prevent cascading errors */
const persistErrorToActivityLog = async (context: ErrorContext): Promise<void> => {
  if (errorPersistGuard.active) return;
  errorPersistGuard.active = true;
  try {
    await logActivity(formatErrorMessage(context), context.eventId ?? null);
  } catch {
    // Swallow DB errors to avoid cascading failures
  } finally {
    errorPersistGuard.active = false;
  }
};

/**
 * Log a classified error to console.error and persist to the activity log.
 * Console output uses error codes and safe metadata (never PII).
 * Activity log entry is encrypted and visible to admins on the log pages.
 */
export const logError = (context: ErrorContext): void => {
  const { code, eventId, attendeeId, detail } = context;

  const parts = [
    `[Error] ${code}`,
    eventId !== undefined ? `event=${eventId}` : null,
    attendeeId !== undefined ? `attendee=${attendeeId}` : null,
    detail ? `detail="${detail}"` : null,
  ].filter(Boolean);

  // biome-ignore lint/suspicious/noConsole: Intentional error logging
  console.error(`${getLogPrefix()}${parts.join(" ")}`);

  addPendingWork(sendNtfyError(code));
  addPendingWork(persistErrorToActivityLog(context));
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
  | "Domain"
  | "Email";

/**
 * Log a debug message with category prefix
 * For detailed debugging during development
 */
export const logDebug = (category: LogCategory, message: string): void => {
  // biome-ignore lint/suspicious/noConsole: Intentional debug logging
  console.debug(`${getLogPrefix()}[${category}] ${message}`);
};
