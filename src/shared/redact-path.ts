/**
 * Strip the secret parts out of a request path, so a log line or an error
 * report can name the route without naming the person on it.
 *
 * A ticket token is the whole credential for that ticket: anybody holding one
 * can open the page. Every path segment that carries one is a secret.
 */

/** Routes that put a secret in the segment straight after the route name. */
const SECRET_AFTER_ROUTE = ["t", "ticket", "wallet", "checkin"];

/**
 * Each rule replaces one dynamic part of a path. Order matters: the numeric-id
 * rule runs before the Wallet webservice rules, which match whatever sits in
 * the device segment, redacted id included.
 */
const RULES: readonly (readonly [RegExp, string])[] = [
  ...SECRET_AFTER_ROUTE.map(
    (route) =>
      [new RegExp(`^/${route}/[^/]+`), `/${route}/[redacted]`] as const,
  ),
  [/\/(\d+)(\/|$)/g, "/[id]$2"],
  [/^\/v1\/devices\/[^/]+/, "/v1/devices/[redacted]"],
  [/^\/v1\/passes\/([^/]+)\/[^/]+/, "/v1/passes/$1/[redacted]"],
  [
    /^\/v1\/devices\/\[redacted\]\/registrations\/([^/]+)\/[^/]+/,
    "/v1/devices/[redacted]/registrations/$1/[redacted]",
  ],
];

/**
 * Redact the dynamic segments of a path. The result is safe to log, to send to
 * an error reporter, and to group error reports by.
 */
export const redactPath = (path: string): string =>
  RULES.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replace(pattern, replacement),
    path,
  );
