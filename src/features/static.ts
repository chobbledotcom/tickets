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
  handleLogisticsMapCss,
  handleLogisticsMapJs,
  handleMarkdownEditorJs,
  handleScannerJs,
  handleScannerServiceWorkerJs,
  handleStyleCss,
} from "#routes/assets.ts";
import { handleRobotsTxt } from "#routes/robots-txt.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { handleSitemapXml } from "#routes/sitemap.ts";

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
  "GET /logistics-map.css": () => handleLogisticsMapCss(),
  "GET /logistics-map.js": () => handleLogisticsMapJs(),
  "GET /markdown-editor.js": () => handleMarkdownEditorJs(),
  "GET /robots.txt": (request) => handleRobotsTxt(request),
  "GET /scanner-service-worker.js": () => handleScannerServiceWorkerJs(),
  "GET /scanner.js": () => handleScannerJs(),
  "GET /sitemap.xml": (request) => handleSitemapXml(request),
  "GET /style.css": () => handleStyleCss(),
});

/** Route static asset requests */
export const routeStatic = createRouter(staticRoutes);
