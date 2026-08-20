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

import { setN1GuardNotifyOnly } from "#db/query-log.ts";
import { once } from "#fp";
import { handleRequest } from "#routes";
import { temporaryErrorResponse } from "#routes/response.ts";
import { validateBootChecks } from "#shared/boot-checks.ts";
import { seedEffectiveDomainHost } from "#shared/config.ts";
import { getEnv } from "#shared/env.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#shared/logger.ts";
import {
  scheduledAccessFromEnv,
  scheduledResponse,
} from "#shared/scheduled-access.ts";
import { initSentry } from "#shared/sentry.ts";

const runtimeLoadFinishedAt = performance.now();

/** The port the local dev entry listens on: PORT when set, else 3000. */
export const devServerPort = (): number => Number(getEnv("PORT") || 3000);

const startedMessage = (
  requestStartedAt: number,
  bootFinishedAt: number,
): string => {
  const runtimeLoadFinished = Math.round(runtimeLoadFinishedAt);
  const requestStarted = Math.round(requestStartedAt);
  const bootFinished = Math.round(bootFinishedAt);
  const started = Math.round(performance.now());
  return `App started (${started}ms: runtime + bundle load ${runtimeLoadFinished}ms, request wait ${
    requestStarted - runtimeLoadFinished
  }ms, boot setup ${bootFinished - requestStarted}ms, Sentry ${
    started - bootFinished
  }ms)`;
};

/** After Sentry init resolves, log where the isolate's boot time was spent. */
const logStartedAfter = async (
  sentryReady: Promise<boolean>,
  requestStartedAt: number,
  bootFinishedAt: number,
): Promise<boolean> => {
  const ready = await sentryReady;
  logDebug("Setup", startedMessage(requestStartedAt, bootFinishedAt));
  return ready;
};

const initialize = once((): Promise<boolean> => {
  const requestStartedAt = performance.now();
  // Throws synchronously, before `once` memoizes — a failed boot is retried.
  validateBootChecks();
  // In production a request must never be killed by the N+1 guard: report it
  // to the error log instead of throwing (dev/test keep the default throw).
  setN1GuardNotifyOnly(true);
  const bootFinishedAt = performance.now();
  // Start Sentry error reporting (no-op unless SENTRY_URL is configured).
  // Loads the SDK lazily; the returned promise is awaited before serving so
  // an error in the very first request still reaches Sentry.
  const sentryReady = initSentry();
  return logStartedAfter(sentryReady, requestStartedAt, bootFinishedAt);
});

/**
 * Lazily boot the app, then serve the request. An unhandled error is logged and
 * turned into a generic 503 so a single bad request never crashes the isolate.
 */
export const serveHandler = async (request: Request): Promise<Response> => {
  const scheduledAccess = scheduledAccessFromEnv(request);
  if (scheduledAccess.kind === "rejected") {
    return scheduledResponse(scheduledAccess.status);
  }
  const url = new URL(request.url);
  if (scheduledAccess.kind === "authorized") seedEffectiveDomainHost(url);
  try {
    await initialize();
    if (scheduledAccess.kind === "authorized") {
      const { handleScheduledRequest } = await import("#routes/scheduled.ts");
      return await handleScheduledRequest(request);
    }
    return await handleRequest(request);
  } catch (error) {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `unhandled ${formatRequestError(
        request.method,
        url.pathname,
        error,
      )}`,
      error,
    });
    return scheduledAccess.kind === "authorized"
      ? scheduledResponse(503)
      : temporaryErrorResponse();
  }
};
