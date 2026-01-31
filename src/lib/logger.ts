/**
 * Privacy-safe logging utilities
 *
 * - Request logging: logs method, path (slugs redacted), status, duration
 * - Error logging: logs classified error codes without PII
 */

/**
 * Error codes for classified error logging
 * Format: E_CATEGORY_DETAIL
 */
export const ErrorCode = {
  // Database errors
  DB_CONNECTION: "E_DB_CONNECTION",
  DB_QUERY: "E_DB_QUERY",

  // Capacity/availability errors
  CAPACITY_EXCEEDED: "E_CAPACITY_EXCEEDED",

  // Encryption/decryption errors
  DECRYPT_FAILED: "E_DECRYPT_FAILED",
  ENCRYPT_FAILED: "E_ENCRYPT_FAILED",
  KEY_DERIVATION: "E_KEY_DERIVATION",

  // Authentication errors
  AUTH_INVALID_SESSION: "E_AUTH_INVALID_SESSION",
  AUTH_EXPIRED: "E_AUTH_EXPIRED",
  AUTH_CSRF_MISMATCH: "E_AUTH_CSRF_MISMATCH",
  AUTH_RATE_LIMITED: "E_AUTH_RATE_LIMITED",

  // Payment provider errors (provider-agnostic)
  PAYMENT_SIGNATURE: "E_PAYMENT_SIGNATURE",
  PAYMENT_SESSION: "E_PAYMENT_SESSION",
  PAYMENT_REFUND: "E_PAYMENT_REFUND",
  PAYMENT_CHECKOUT: "E_PAYMENT_CHECKOUT",
  PAYMENT_WEBHOOK_SETUP: "E_PAYMENT_WEBHOOK_SETUP",

  // Stripe-specific errors (used by stripe.ts internals)
  STRIPE_SIGNATURE: "E_STRIPE_SIGNATURE",
  STRIPE_SESSION: "E_STRIPE_SESSION",
  STRIPE_REFUND: "E_STRIPE_REFUND",
  STRIPE_CHECKOUT: "E_STRIPE_CHECKOUT",
  STRIPE_WEBHOOK_SETUP: "E_STRIPE_WEBHOOK_SETUP",

  // Square-specific errors (used by square.ts internals)
  SQUARE_SIGNATURE: "E_SQUARE_SIGNATURE",
  SQUARE_SESSION: "E_SQUARE_SESSION",
  SQUARE_REFUND: "E_SQUARE_REFUND",
  SQUARE_CHECKOUT: "E_SQUARE_CHECKOUT",
  SQUARE_ORDER: "E_SQUARE_ORDER",

  // Validation errors
  VALIDATION_FORM: "E_VALIDATION_FORM",
  VALIDATION_CONTENT_TYPE: "E_VALIDATION_CONTENT_TYPE",

  // Webhook errors
  WEBHOOK_SEND: "E_WEBHOOK_SEND",

  // Not found
  NOT_FOUND_EVENT: "E_NOT_FOUND_EVENT",
  NOT_FOUND_ATTENDEE: "E_NOT_FOUND_ATTENDEE",

  // Configuration errors
  CONFIG_MISSING: "E_CONFIG_MISSING",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

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
  const { method, path, status, durationMs } = entry;
  const redactedPath = redactPath(path);

  // biome-ignore lint/suspicious/noConsole: Intentional debug logging
  console.debug(
    `[Request] ${method} ${redactedPath} ${status} ${durationMs}ms`,
  );
};

/**
 * Error log context (privacy-safe metadata only)
 */
type ErrorContext = {
  /** Error code for classification */
  code: ErrorCodeType;
  /** Optional: event ID (not slug) */
  eventId?: number;
  /** Optional: attendee ID */
  attendeeId?: number;
  /** Optional: additional safe context */
  detail?: string;
};

/**
 * Log a classified error to console.error
 * Only logs error codes and safe metadata, never PII
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
  console.error(parts.join(" "));
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
export type LogCategory = "Setup" | "Webhook" | "Payment" | "Auth" | "Stripe" | "Square";

/**
 * Log a debug message with category prefix
 * For detailed debugging during development
 */
export const logDebug = (category: LogCategory, message: string): void => {
  // biome-ignore lint/suspicious/noConsole: Intentional debug logging
  console.debug(`[${category}] ${message}`);
};
