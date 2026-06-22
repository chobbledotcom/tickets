/**
 * Static routes - health check and assets (always available)
 */

import { handleHealthCheck } from "#routes/api/health.ts";
import {
  handleAdminJs,
  handleContactJs,
  handleEmbedJs,
  handleFavicon,
  handleIcons,
  handleIframeResizerChildJs,
  handleIframeResizerParentJs,
  handleRobotsTxt,
  handleScannerJs,
  handleStyleCss,
} from "#routes/assets.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

/** Static routes definition */
const staticRoutes = defineRoutes({
  "GET /admin.js": () => handleAdminJs(),
  "GET /contact.js": () => handleContactJs(),
  "GET /embed.js": () => handleEmbedJs(),
  "GET /favicon.ico": () => handleFavicon(),
  "GET /health": (request) => handleHealthCheck(request),
  "GET /icons.svg": () => handleIcons(),
  "GET /iframe-resizer-child.js": () => handleIframeResizerChildJs(),
  "GET /iframe-resizer-parent.js": () => handleIframeResizerParentJs(),
  "GET /robots.txt": () => handleRobotsTxt(),
  "GET /scanner.js": () => handleScannerJs(),
  "GET /style.css": () => handleStyleCss(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
