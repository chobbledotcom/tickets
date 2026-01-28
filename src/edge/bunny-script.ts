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
    return handleRequest(request);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: Edge script error logging
    console.error("[Tickets] Request error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
