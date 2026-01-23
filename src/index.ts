/**
 * Entry point for ticket reservation system
 */

import { validateEncryptionKey } from "#lib/crypto.ts";
import { initDb } from "#lib/db/migrations/index.ts";
import { handleRequest } from "#routes/index.ts";

const startServer = async (port = 3000): Promise<void> => {
  validateEncryptionKey();
  await initDb();
  Bun.write(Bun.stdout, `Server starting on http://localhost:${port}\n`);

  Bun.serve({
    port,
    fetch: handleRequest,
  });
};

const port = Number.parseInt(process.env.PORT || "3000", 10);
startServer(port);
