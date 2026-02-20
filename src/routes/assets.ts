/**
 * Static asset routes - CSS, JS, and favicon with long cache
 */

import { dirname, fromFileUrl, join } from "@std/path";

const currentDir = dirname(fromFileUrl(import.meta.url));
const staticDir = join(currentDir, "..", "static");

/** Cache for 1 year (immutable assets) */
const CACHE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
};

/** Create a handler that serves a static file with the given content type */
const staticHandler = (filename: string, contentType: string): (() => Response) => {
  const content = Deno.readTextFileSync(join(staticDir, filename));
  return () =>
    new Response(content, {
      headers: { "content-type": contentType, ...CACHE_HEADERS },
    });
};

const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const SVG = "image/svg+xml";
const TEXT = "text/plain; charset=utf-8";

export const handleRobotsTxt = staticHandler("robots.txt", TEXT);
export const handleFavicon = staticHandler("favicon.svg", SVG);
export const handleMvpCss = staticHandler("mvp.css", CSS);
export const handleAdminJs = staticHandler("admin.js", JS);
export const handleScannerJs = staticHandler("scanner.js", JS);
export const handleEmbedJs = staticHandler("embed.js", JS);
export const handleIframeResizerParentJs = staticHandler("iframe-resizer-parent.js", JS);
export const handleIframeResizerChildJs = staticHandler("iframe-resizer-child.js", JS);
