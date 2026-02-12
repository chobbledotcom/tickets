/**
 * Static routes - health check and assets (always available)
 */

import { handleAdminJs, handleFavicon, handleMvpCss, handleScannerJs } from "#routes/assets.ts";
import { handleHealthCheck } from "#routes/health.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /health": () => handleHealthCheck(),
  "GET /favicon.ico": () => handleFavicon(),
  "GET /mvp.css": () => handleMvpCss(),
  "GET /admin.js": () => handleAdminJs(),
  "GET /scanner.js": () => handleScannerJs(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
