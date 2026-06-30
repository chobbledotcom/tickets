/**
 * Dynamic `/custom.css` handler for operator-supplied custom styles.
 *
 * Runs inside the normal request pipeline (after settings load) rather than as
 * a built-in static asset, because the body is the `custom_css` setting. It is
 * served with the same long, immutable cache as the other static assets so the
 * CDN — not the origin — answers the vast majority of requests; that is why no
 * other route reads `custom_css`. The page `<link>` cache-busts the URL with
 * `?v=<settings version>` (mirroring the build-time `?ts=` on /style.css), so a
 * CSS edit bumps the settings version, changes the URL, and is fetched fresh —
 * while an unchanged URL stays immutable.
 *
 * The response is always `text/css` (even when the setting is blank), so a
 * browser will only ever treat the body as a stylesheet — never as a script or
 * document an operator could smuggle something into.
 */

import { encodeBody } from "#routes/response.ts";
import { settings } from "#shared/db/settings.ts";

const CSS_CONTENT_TYPE = "text/css; charset=utf-8";

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
