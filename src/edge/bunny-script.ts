/**
 * Ticket Reservation System - Bunny Edge Script
 * Entry point for Bunny CDN edge deployment
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { validateEncryptionKey } from "../lib/crypto.ts";
import { initDb } from "../lib/db.ts";
import { handleRequest } from "../server.ts";

// biome-ignore lint/suspicious/noConsole: Edge script logging
console.log("[Tickets] Edge script module loaded");

let initialized = false;

// biome-ignore lint/suspicious/noConsole: Edge script logging
console.log("[Tickets] Registering HTTP handler...");

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    if (!initialized) {
      // biome-ignore lint/suspicious/noConsole: Edge script logging
      console.log("[Tickets] Validating encryption key...");
      validateEncryptionKey();
      // biome-ignore lint/suspicious/noConsole: Edge script logging
      console.log("[Tickets] Initializing database...");
      await initDb();
      initialized = true;
      // biome-ignore lint/suspicious/noConsole: Edge script logging
      console.log("[Tickets] Database initialized successfully");
    }
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

// biome-ignore lint/suspicious/noConsole: Edge script logging
console.log("[Tickets] HTTP handler registered");
