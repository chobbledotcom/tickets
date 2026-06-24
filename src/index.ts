/**
 * Entry point for ticket reservation system
 */

import { handleRequest } from "#routes/index.ts";
import { validateEncryptionKey } from "#shared/crypto/encryption.ts";
import { logDebug } from "#shared/logger.ts";
import { initSentry } from "#shared/sentry.ts";

const startServer = (port = 3000): void => {
  validateEncryptionKey();
  initSentry();
  logDebug("Setup", `Server starting on http://localhost:${port}`);

  Deno.serve({ port }, (request) => handleRequest(request));
};

const port = Number.parseInt(Deno.env.get("PORT") || "3000", 10);
startServer(port);
