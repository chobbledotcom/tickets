/**
 * Static asset routes - CSS and favicon with long cache
 */

import { dirname, fromFileUrl, join } from "@std/path";

const currentDir = dirname(fromFileUrl(import.meta.url));
const staticDir = join(currentDir, "..", "static");

// Read static files at module load time
// These get inlined by esbuild during edge build
const faviconSvg = Deno.readTextFileSync(join(staticDir, "favicon.svg"));
const mvpCss = Deno.readTextFileSync(join(staticDir, "mvp.css"));

/** Cache for 1 year (immutable assets) */
const CACHE_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
};

/**
 * Handle MVP.css request
 */
export const handleMvpCss = (): Response =>
  new Response(mvpCss, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      ...CACHE_HEADERS,
    },
  });

/**
 * Handle favicon request
 */
export const handleFavicon = (): Response =>
  new Response(faviconSvg, {
    headers: {
      "content-type": "image/svg+xml",
      ...CACHE_HEADERS,
    },
  });
