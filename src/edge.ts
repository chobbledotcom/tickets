/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { once } from "#fp";
import { validateEncryptionKey } from "#lib/crypto/encryption.ts";
import { initDb } from "#lib/db/migrations.ts";
import {
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
} from "#lib/logger.ts";
import { handleRequest } from "#routes";
import { temporaryErrorResponse } from "#routes/utils.ts";

const initialize = once(async (): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  logDebug("Setup", "App started");
});

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    await initialize();
    return await handleRequest(request);
  } catch (error) {
    const url = new URL(request.url);
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `unhandled ${formatRequestError(request.method, url.pathname, error)}`,
    });
    return temporaryErrorResponse();
  }
});
