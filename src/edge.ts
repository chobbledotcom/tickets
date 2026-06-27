/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
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

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
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
});
