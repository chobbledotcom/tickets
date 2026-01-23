/**
 * Static routes - health check and assets (always available)
 */

import { handleFavicon, handleMvpCss } from "./assets.ts";
import { handleHealthCheck } from "./health.ts";
import { createRouter, defineRoutes } from "./router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /health": () => handleHealthCheck(),
  "GET /favicon.ico": () => handleFavicon(),
  "GET /mvp.css": () => handleMvpCss(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
