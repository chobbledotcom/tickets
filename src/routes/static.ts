/**
 * Static routes - health check and assets (always available)
 */

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
import { handleHealthCheck } from "#routes/health.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /health": () => handleHealthCheck(),
  "GET /robots.txt": () => handleRobotsTxt(),
  "GET /favicon.ico": () => handleFavicon(),
  "GET /mvp.css": () => handleMvpCss(),
  "GET /admin.js": () => handleAdminJs(),
  "GET /scanner.js": () => handleScannerJs(),
  "GET /embed.js": () => handleEmbedJs(),
  "GET /iframe-resizer-parent.js": () => handleIframeResizerParentJs(),
  "GET /iframe-resizer-child.js": () => handleIframeResizerChildJs(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
