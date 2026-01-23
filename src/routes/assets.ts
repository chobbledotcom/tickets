/**
 * Static asset routes - CSS and favicon with long cache
 */

import faviconSvg from "#static/favicon.svg" with { type: "text" };
import mvpCss from "#static/mvp.css" with { type: "text" };

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
