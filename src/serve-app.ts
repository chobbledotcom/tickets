/**
 * Shared production request handler for the server entry points.
 *
 * The Bunny edge entry (`edge.ts`), the Deno Deploy entry (`deploy.ts`), and
 * the local dev entry (`index.ts`) all wrap the router identically: boot the
 * app once, run `handleRequest`, and turn any unhandled error into a logged
 * generic 503 rather than letting it crash the isolate. Kept here so every
 * entry point shares one implementation — and so the boot/serve behaviour is
 * unit-testable (`test/serve-app.test.ts`) while the entry files stay
 * logic-free one-liners. Each platform hands over the client IP its own way,
 * so each entry point has its own adapter.
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
const serveHandler = async (
  request: Request,
  clientIp: string,
): Promise<Response> => {
  const scheduledAccess = scheduledAccessFromEnv(request);
  if (scheduledAccess.kind === "rejected") {
    return scheduledResponse(scheduledAccess.status);
  }
  const url = new URL(request.url);
  // Seed before any context opens: a boot failure reports out of request,
  // and the fallback must name this site, not the default.
  if (scheduledAccess.kind === "authorized") seedEffectiveDomainHost(url);
  try {
    await initialize();
    if (scheduledAccess.kind === "authorized") {
      const { handleScheduledRequest } = await import("#routes/scheduled.ts");
      return await handleScheduledRequest(request);
    }
    return await handleRequest(request, clientIp);
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
      : temporaryErrorResponse(request.method);
  }
};

/** Bunny gives the handler only the request. The Bunny CDN puts the client
 * address in `x-real-ip`, so a request without it is a platform fault. */
export const bunnyServeHandler = (request: Request): Promise<Response> => {
  const ip = request.headers.get("x-real-ip");
  if (!ip) throw new Error("Bunny request has no x-real-ip header");
  return serveHandler(request, ip);
};

/** Deno gives the client address of the TCP connection. */
export const denoServeHandler = (
  request: Request,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
): Promise<Response> => serveHandler(request, info.remoteAddr.hostname);
