/**
 * Entry point for ticket reservation system
 */

import { validateEncryptionKey } from "#lib/crypto.ts";
import { initDb } from "#lib/db/migrations/index.ts";
import { handleRequest } from "#routes/index.ts";

const startServer = async (port = 3000): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  console.log(`Server starting on http://localhost:${port}`);

  Deno.serve({ port }, (request) => handleRequest(request));
};

const port = Number.parseInt(Deno.env.get("PORT") || "3000", 10);
startServer(port);
