/**
 * Shared production request handler for the server entry points.
 *
 * The Bunny edge entry (`edge.ts`), the Deno Deploy entry (`deploy.ts`), and
 * the local dev entry (`index.ts`) all wrap the router identically: boot the
 * app once, run `handleRequest`, and turn any unhandled error into a logged
 * generic 503 rather than letting it crash the isolate. Kept here so every
 * entry point shares one implementation — and so the boot/serve behaviour is
 * unit-testable (`test/lib/serve-app.test.ts`) while the entry files stay
 * logic-free one-liners.
 */

import { once } from "#fp";
import { handleRequest } from "#routes";
import { temporaryErrorResponse } from "#routes/response.ts";
import { validateBootChecks } from "#shared/boot-checks.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { getEnv } from "#shared/env.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { initSentry } from "#shared/sentry.ts";

/** The port the local dev entry listens on: PORT when set, else 3000. */
export const devServerPort = (): number => Number(getEnv("PORT") || 3000);

const initialize = once((): Promise<boolean> => {
  validateBootChecks();
  // Start Sentry error reporting (no-op unless SENTRY_URL is configured).
  // Loads the SDK lazily; the returned promise is awaited before serving so
  // an error in the very first request still reaches Sentry.
  const sentryReady = initSentry();
  // In production a request must never be killed by the N+1 guard: report it
  // to the error log instead of throwing (dev/test keep the default throw).
  setN1GuardNotifyOnly(true);
  // performance.now() counts from process start, so this is how long the
  // isolate spent booting (runtime start + bundle load) before going live.
  logDebug("Setup", `App started (${Math.round(performance.now())}ms)`);
  return sentryReady;
});

/**
 * Lazily boot the app, then serve the request. An unhandled error is logged and
 * turned into a generic 503 so a single bad request never crashes the isolate.
 */
export const serveHandler = async (request: Request): Promise<Response> => {
  try {
    await initialize();
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
