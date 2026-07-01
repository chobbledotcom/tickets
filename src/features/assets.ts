/**
 * Static asset routes - CSS, JS, and favicon with long cache
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { once } from "#fp";
import { encodeBody } from "#routes/response.ts";

const currentDir = dirname(fromFileUrl(import.meta.url));
const staticDir = join(currentDir, "..", "ui", "static");

/** Cache for 1 year (immutable assets) */
const CACHE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
};

/** Create a handler that serves a static file with the given content type */
const staticHandler = (
  filename: string,
  contentType: string,
): (() => Response) => {
  const content = encodeBody(Deno.readTextFileSync(join(staticDir, filename)));
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
export const handleIcons = staticHandler("icons.svg", SVG);
export const handleStyleCss = staticHandler("style.css", CSS);
export const handleAdminJs = staticHandler("admin.js", JS);
export const handleScannerJs = staticHandler("scanner.js", JS);
export const handleEmbedJs = staticHandler("embed.js", JS);
export const handleContactJs = staticHandler("contact.js", JS);
export const handleIframeResizerParentJs = staticHandler(
  "iframe-resizer-parent.js",
  JS,
);
export const handleIframeResizerChildJs = staticHandler(
  "iframe-resizer-child.js",
  JS,
);

/** The raw ESM body of the external-order widget (`/order.js`). Exposed here —
 * rather than read in the handler — so the edge build inlines it the same way
 * it inlines the other static assets (the dynamic `/order.js` route prepends the
 * per-request catalog to this string). Returns the unencoded source text.
 *
 * The widget body never changes for the life of the process, and `/order.js` is
 * hit on every embedding page load, so the file is read once and cached. (The
 * edge build replaces this whole module with a pre-inlined constant; the cache
 * only spares the per-request `readTextFileSync` on the Deno dev/Deploy path.) */
export const orderWidgetBody = once((): string =>
  Deno.readTextFileSync(join(staticDir, "order.js")),
);
