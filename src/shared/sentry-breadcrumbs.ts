/**
 * Keep a report's breadcrumbs to the request that made it.
 *
 * The SDK collects console lines onto one shared scope, and it ships no
 * async-context strategy for Deno, so `withIsolationScope` cannot separate one
 * request from another. An edge isolate serves many requests, so a report would
 * arrive carrying the lines of whichever requests ran beside it.
 *
 * Every line the logger prints starts with the request's own id, so the report
 * can simply keep the lines that are its own. This module is pure: it takes the
 * id and the lines, and returns the lines to keep.
 */

/** The part of a breadcrumb this module reads. */
export type LoggedLine = { message?: string | undefined };

/** How `getLogPrefix` in the logger stamps a line with its request id. */
const prefixFor = (requestId: string): string => `[${requestId}] `;

/**
 * The lines belonging to one request. Outside a request there is no id to
 * match on, so every line is kept — a boot or scheduled-run report has no
 * other request to be confused with.
 */
export const linesForRequest = <T extends LoggedLine>(
  requestId: string | undefined,
  lines: T[],
): T[] =>
  requestId === undefined
    ? lines
    : lines.filter((line) => line.message?.startsWith(prefixFor(requestId)));
