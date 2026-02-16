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

export const handleFavicon = staticHandler("favicon.svg", "image/svg+xml");
export const handleMvpCss = staticHandler("mvp.css", "text/css; charset=utf-8");
export const handleAdminJs = staticHandler("admin.js", "application/javascript; charset=utf-8");
export const handleScannerJs = staticHandler("scanner.js", "application/javascript; charset=utf-8");
export const handleIframeResizerParentJs = staticHandler("iframe-resizer-parent.js", "application/javascript; charset=utf-8");
export const handleIframeResizerChildJs = staticHandler("iframe-resizer-child.js", "application/javascript; charset=utf-8");
export const handleEmbedJs = staticHandler("embed.js", "application/javascript; charset=utf-8");
