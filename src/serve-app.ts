/**
 * Shared production request handler for the server entry points.
 *
 * Both the Bunny edge entry (`edge.ts`) and the Deno Deploy entry (`deploy.ts`)
 * wrap the router identically: boot the app once, run `handleRequest`, and turn
 * any unhandled error into a logged generic 503 rather than letting it crash the
 * isolate. Kept here so the two entry points share one implementation. Like the
 * other entry points (`edge.ts`, `index.ts`) it drives the live router/boot
 * path and is never imported by tests, so it carries no unit tests of its own.
 */

import { once } from "#fp";
import { handleRequest } from "#routes";
import { temporaryErrorResponse } from "#routes/response.ts";
import { validateBootChecks } from "#shared/boot-checks.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { initSentry } from "#shared/sentry.ts";

const initialize = once((): void => {
  validateBootChecks();
  // Start Sentry error reporting (no-op unless SENTRY_URL is configured).
  initSentry();
  // In production a request must never be killed by the N+1 guard: report it
  // to the error log instead of throwing (dev/test keep the default throw).
  setN1GuardNotifyOnly(true);
  logDebug("Setup", "App started");
});

/**
 * Lazily boot the app, then serve the request. An unhandled error is logged and
 * turned into a generic 503 so a single bad request never crashes the isolate.
 */
export const serveHandler = async (request: Request): Promise<Response> => {
  try {
    initialize();
    return await handleRequest(request);
  } catch (error) {
    const url = new URL(request.url);
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `unhandled ${formatRequestError(
        request.method,
        url.pathname,
        error,
      )}`,
      error,
    });
    return temporaryErrorResponse();
  }
};
