/**
 * Static routes - health check and favicon (always available)
 */

import { handleFavicon } from "#routes/favicon.ts";
import { handleHealthCheck } from "#routes/health.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /health": () => handleHealthCheck(),
  "GET /favicon.ico": () => handleFavicon(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
