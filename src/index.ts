/**
 * Entry point for ticket reservation system
 */

import { getOrCreateAdminPassword, initDb } from "./lib/db.ts";
import { handleRequest } from "./server.ts";

const startServer = async (port = 3000): Promise<void> => {
  await initDb();

  const password = await getOrCreateAdminPassword();
  console.log(`Admin password: ${password}`);
  console.log(`Server starting on http://localhost:${port}`);

  Bun.serve({
    port,
    fetch: handleRequest,
  });
};

const port = Number.parseInt(process.env.PORT || "3000", 10);
startServer(port);
