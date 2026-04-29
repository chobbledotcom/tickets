/**
 * Static routes - health check and assets (always available)
 */

import { handleHealthCheck } from "#routes/api/health.ts";
import {
  handleAdminJs,
  handleEmbedJs,
  handleFavicon,
  handleIframeResizerChildJs,
  handleIframeResizerParentJs,
  handleMvpCss,
  handleRobotsTxt,
  handleScannerJs,
} from "#routes/assets.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /admin.js": () => handleAdminJs(),
  "GET /embed.js": () => handleEmbedJs(),
  "GET /favicon.ico": () => handleFavicon(),
  "GET /health": () => handleHealthCheck(),
  "GET /iframe-resizer-child.js": () => handleIframeResizerChildJs(),
  "GET /iframe-resizer-parent.js": () => handleIframeResizerParentJs(),
  "GET /mvp.css": () => handleMvpCss(),
  "GET /robots.txt": () => handleRobotsTxt(),
  "GET /scanner.js": () => handleScannerJs(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
