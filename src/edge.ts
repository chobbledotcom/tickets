/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { once } from "#fp";
import { validateEncryptionKey } from "#lib/crypto.ts";
import { initDb } from "#lib/db/migrations.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { handleRequest } from "#routes";
import { encodeBody } from "#routes/utils.ts";

const initialize = once(async (): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  logDebug("Setup", "App started");
});

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    await initialize();
    return await handleRequest(request);
  } catch {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: "unhandled request error",
    });
    return new Response(
      encodeBody(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="2"><title>Temporary Error</title></head><body><h1>Temporary Error</h1><p>Something went wrong loading this page. Retrying automatically&hellip;</p></body></html>',
      ),
      {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
});
