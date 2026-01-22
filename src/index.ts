/**
 * Entry point for ticket reservation system
 */

import { handleRequest } from "#routes";
import { initDb } from "./lib/db.ts";

const startServer = async (port = 3000): Promise<void> => {
  await initDb();
  console.log(`Server starting on http://localhost:${port}`);

  Bun.serve({
    port,
    fetch: handleRequest,
  });
};

const port = Number.parseInt(process.env.PORT || "3000", 10);
startServer(port);
