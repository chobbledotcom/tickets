/**
 * Static routes - health check and favicon (always available)
 */

import { handleFavicon } from "./favicon.ts";
import { handleHealthCheck } from "./health.ts";
import { createRouter, defineRoutes } from "./router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /health": () => handleHealthCheck(),
  "GET /favicon.ico": () => handleFavicon(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
