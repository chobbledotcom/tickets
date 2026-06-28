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

import { dirname, fromFileUrl, join } from "@std/path";
import { once } from "#fp";
import { getDecimalPlaces } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";
import { parseEmbedHosts } from "#shared/embed-hosts.ts";
import {
  buildCatalog,
  resolveAllowOrigin,
  serializeCatalog,
} from "#shared/external-order.ts";
import { nowIso } from "#shared/now.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";

const JS_CONTENT_TYPE = "application/javascript; charset=utf-8";

const staticDir = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "ui",
  "static",
);

/** The built widget bundle, read once on first use. Read lazily (not at import)
 * so importing this module never depends on the static build having run. */
const widgetBody = once((): string =>
  Deno.readTextFileSync(join(staticDir, "order.js")),
);

/** Served when the system is disabled. Carries no listing data, so it is safe
 * to expose to any origin — the `*` lets the notice surface wherever the owner
 * placed the tag. `export {}` keeps it a module for consistency. */
const DISABLED_STUB =
  'console.warn("Chobble Tickets: the external order library is not enabled for this site.");\nexport {};\n';

const jsResponse = (body: string, headers: Record<string, string>): Response =>
  new Response(body, {
    headers: { "content-type": JS_CONTENT_TYPE, ...headers },
  });

/** Handle `GET /order.js`. */
export const handleOrderJs = async (request: Request): Promise<Response> => {
  if (!settings.externalOrderEnabled) {
    return jsResponse(DISABLED_STUB, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
  }

  const allowOrigin = resolveAllowOrigin(
    request.headers.get("origin"),
    parseEmbedHosts(settings.embedHosts),
  );
  const currency = settings.currency;
  const { listings } = await loadSortedListings(
    (listing) => listing.active && !listing.hidden,
  );
  const catalog = buildCatalog({
    currency,
    decimalPlaces: getDecimalPlaces(currency),
    generatedAt: nowIso(),
    listings,
    origin: new URL(request.url).origin,
  });

  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "cross-origin-resource-policy": "cross-origin",
    vary: "Origin",
  };
  if (allowOrigin !== null) {
    headers["access-control-allow-origin"] = allowOrigin;
  }
  return jsResponse(`${serializeCatalog(catalog)}\n${widgetBody()}`, headers);
};
