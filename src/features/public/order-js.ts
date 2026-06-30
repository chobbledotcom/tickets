/**
 * Dynamic `/order.js` handler for the external order library.
 *
 * Runs inside the normal request pipeline (after settings load), unlike the
 * static asset routes, because its response depends on mutable settings and the
 * request `Origin`:
 * - when `external_order_enabled` is off it returns a harmless console-notice
 *   stub (no listing data) so an owner who left the tag in place sees why their
 *   cart isn't working, without leaking any slugs;
 * - when on it embeds the public listing catalog and gates the cross-origin
 *   CORS header on the `embed_hosts` allow-list.
 *
 * The widget body is the ESM bundle built from `src/ui/client/order.ts`; the
 * per-request catalog is prepended as a `const CATALOG = {…};` statement.
 */

import { orderWidgetBody } from "#routes/assets.ts";
import { encodeBody } from "#routes/response.ts";
import { getDecimalPlaces } from "#shared/currency.ts";
import { getCatalogListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { parseEmbedHosts } from "#shared/embed-hosts.ts";
import {
  buildCatalog,
  resolveAllowOrigin,
  serializeCatalog,
} from "#shared/external-order.ts";
import { nowIso } from "#shared/now.ts";

const JS_CONTENT_TYPE = "application/javascript; charset=utf-8";

/** Served when the system is disabled. Carries no listing data, so it is safe
 * to expose to any origin — the `*` lets the notice surface wherever the owner
 * placed the tag. `export {}` keeps it a module for consistency. */
const DISABLED_STUB =
  'console.warn("Chobble Tickets: the external order library is not enabled for this site.");\nexport {};\n';

/** Served to origins not on the embed-hosts allow-list: no catalog, no CORS
 * header (so a browser blocks it anyway), and a console notice for debugging. */
const DISALLOWED_STUB =
  'console.warn("Chobble Tickets: this site is not allowed to load the order library.");\nexport {};\n';

// Pre-encode the constant stub bodies once. `/order.js` is fetched on every
// page that embeds the tag, and the no-catalog stubs (feature disabled, or a
// denied origin) are the common case for a site that hasn't finished setup, so
// the bytes are encoded at module load instead of on every request. The
// encoded buffers are never mutated, so reusing them across responses is safe.
const DISABLED_STUB_BODY = encodeBody(DISABLED_STUB);
const DISALLOWED_STUB_BODY = encodeBody(DISALLOWED_STUB);

// Pre-encode to bytes: Bunny Edge intermittently fails to decode raw string
// bodies, so all text responses go out as Uint8Array (see encodeBody).
const jsResponse = (
  body: ArrayBuffer,
  headers: Record<string, string>,
): Response =>
  new Response(body, {
    headers: { "content-type": JS_CONTENT_TYPE, ...headers },
  });

/** Handle `GET /order.js`. */
export const handleOrderJs = async (request: Request): Promise<Response> => {
  if (!settings.externalOrderEnabled) {
    return jsResponse(DISABLED_STUB_BODY, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
  }

  const allowOrigin = resolveAllowOrigin(
    request.headers.get("origin"),
    parseEmbedHosts(settings.embedHosts),
  );
  // Disallowed (or missing) origin against a non-empty allow-list: don't build
  // or expose the catalog at all. Returning before the query both keeps the
  // listing data off non-browser/denied reads (CORS only stops module
  // evaluation, not the response body) and avoids the DB/decryption cost on
  // requests that could never use it.
  if (allowOrigin === null) {
    return jsResponse(DISALLOWED_STUB_BODY, { "cache-control": "no-store" });
  }

  // Parse the request URL once: it supplies both the catalog origin and the
  // `?debug=true` flag that turns on the widget's verbose console logging.
  const url = new URL(request.url);
  const currency = settings.currency;
  const catalog = buildCatalog({
    currency,
    debug: url.searchParams.get("debug") === "true",
    decimalPlaces: getDecimalPlaces(currency),
    generatedAt: nowIso(),
    listings: await getCatalogListings(),
    origin: url.origin,
  });

  return jsResponse(
    encodeBody(`${serializeCatalog(catalog)}\n${orderWidgetBody()}`),
    {
      "access-control-allow-origin": allowOrigin,
      "cache-control": "no-store",
      "cross-origin-resource-policy": "cross-origin",
      vary: "Origin",
    },
  );
};
