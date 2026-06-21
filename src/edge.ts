/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { once } from "#fp";
import { handleRequest } from "#routes";
import {
  databaseBusyResponse,
  temporaryErrorResponse,
} from "#routes/response.ts";
import { validateEncryptionKey } from "#shared/crypto/encryption.ts";
import { DatabaseBusyError } from "#shared/db/client.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#shared/logger.ts";

const initialize = once((): void => {
  validateEncryptionKey();
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
    // A database too busy to acquire a write lock is a transient, expected load
    // condition — show the friendly auto-reloading busy page, not a logged error.
    if (error instanceof DatabaseBusyError) return databaseBusyResponse();
    const url = new URL(request.url);
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `unhandled ${formatRequestError(
        request.method,
        url.pathname,
        error,
      )}`,
    });
    return temporaryErrorResponse();
  }
});
