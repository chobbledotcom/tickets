/**
 * Entry point for ticket reservation system
 */

import { handleRequest } from "#routes/index.ts";
import { validateEncryptionKey } from "#shared/crypto/encryption.ts";
import { initDb } from "#shared/db/migrations.ts";
import { logDebug } from "#shared/logger.ts";

const startServer = async (port = 3000): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  logDebug("Setup", `Server starting on http://localhost:${port}`);

  Deno.serve({ port }, (request) => handleRequest(request));
};

const port = Number.parseInt(Deno.env.get("PORT") || "3000", 10);
startServer(port);
