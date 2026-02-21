/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { once } from "#fp";
import { validateEncryptionKey } from "#lib/crypto.ts";
import { initDb } from "#lib/db/migrations/index.ts";
import { handleRequest } from "#routes";

const initialize = once(async (): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  // biome-ignore lint/suspicious/noConsole: Edge script logging
  console.log("[Tickets] App started");
});

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    await initialize();
    return await handleRequest(request);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Edge script error logging
    console.error("[Tickets] Request error:", error);
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="2"><title>Temporary Error</title></head><body><h1>Temporary Error</h1><p>Something went wrong loading this page. Retrying automatically&hellip;</p></body></html>',
      {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
});
