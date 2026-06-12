/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { once } from "#fp";
import { handleRequest } from "#routes";
import { temporaryErrorResponse } from "#routes/response.ts";
import { validateEncryptionKey } from "#shared/crypto/encryption.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#shared/logger.ts";

const initialize = once((): void => {
  validateEncryptionKey();
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
    });
    return temporaryErrorResponse();
  }
});
