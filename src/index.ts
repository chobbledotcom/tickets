/**
 * Entry point for ticket reservation system
 */

import { handleRequest } from "#routes/index.ts";
import { validateBootChecks } from "#shared/boot-checks.ts";
import { logDebug } from "#shared/logger.ts";
import { initSentry } from "#shared/sentry.ts";

const startServer = async (port = 3000): Promise<void> => {
  validateBootChecks();
  await initSentry();
  logDebug("Setup", `Server starting on http://localhost:${port}`);

  Deno.serve({ port }, (request) => handleRequest(request));
};

const port = Number.parseInt(Deno.env.get("PORT") || "3000", 10);
await startServer(port);
