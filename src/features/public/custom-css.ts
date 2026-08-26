/**
 * Served with the same long, immutable cache as the static assets, so the CDN
 * answers almost every request. That is why no other route reads `custom_css`.
 * The page `<link>` cache-busts with `?v=<settings version>`, so an edit bumps
 * the version, changes the URL, and is fetched fresh.
 *
 * The response is always `text/css`, even when the setting is blank, so a
 * browser can only ever treat the body as a stylesheet.
 */

import { settings } from "#db/settings.ts";
import { encodeBody } from "#routes/response.ts";

export const CSS_CONTENT_TYPE = "text/css; charset=utf-8";

/** Handle `GET /custom.css`. */
export const handleCustomCss = (): Response =>
  // Pre-encode to bytes: Bunny Edge intermittently fails to decode raw string
  // bodies, so all text responses go out as Uint8Array (see encodeBody).
  new Response(encodeBody(settings.customCss), {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": CSS_CONTENT_TYPE,
    },
  });

/** True when a response is already a stylesheet (content-type is `text/css`). */
export const isCssResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/css");

/**
 * Empty, uncached stylesheet served for `/custom.css` when the request pipeline
 * would otherwise answer with an HTML system page (site-not-activated,
 * migration-in-progress, transient error). The public layout links
 * `/custom.css` on *every* page — including those system pages — so returning
 * HTML there trips the browser's strict MIME check. This keeps the asset a
 * stylesheet in every state; it is deliberately `no-store` so it can never be
 * cached in place of the operator's real CSS once the site is healthy.
 */
export const emptyCustomCssResponse = (): Response =>
  new Response(encodeBody(""), {
    headers: {
      "cache-control": "no-store",
      "content-type": CSS_CONTENT_TYPE,
    },
  });
