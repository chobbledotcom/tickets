/**
 * External order library — shared pure logic.
 *
 * Powers the `/order.js` module: deciding which external origins may load it
 * (CORS), and building the public listing catalog that is embedded in the
 * served module. Kept free of DB and settings access so it is trivially
 * testable; the handler in `src/features/public/order-js.ts` supplies the live
 * listings, currency, and request origin.
 */

import type { Listing } from "#shared/types.ts";

// ---------------------------------------------------------------------------
// Origin / CORS matching
// ---------------------------------------------------------------------------

/** Parse the hostname out of an `Origin` header value, lowercased. Returns
 * null for a missing or malformed origin (both are normal for hostile or
 * non-browser callers). */
const originHostname = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Does a hostname match a single allow-list pattern? Supports an optional
 * `*.` wildcard prefix (`*.example.com` matches `a.example.com` but not the
 * bare apex `example.com`). Patterns are assumed already lowercased by
 * `parseEmbedHosts`. */
export const matchesHostPattern = (
  hostname: string,
  pattern: string,
): boolean => {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
};

/** Is the request origin allowed by the embed-hosts allow-list? An empty list
 * means "allow any site" (the existing embed semantics). */
export const isOriginAllowed = (
  origin: string | null,
  hosts: string[],
): boolean => {
  if (hosts.length === 0) return true;
  if (!origin) return false;
  const hostname = originHostname(origin);
  if (hostname === null) return false;
  return hosts.some((pattern) => matchesHostPattern(hostname, pattern));
};

/** The `Access-Control-Allow-Origin` value to send, or null to omit the header
 * (which makes the browser refuse to evaluate the cross-origin module):
 * - empty allow-list → `*` (any site);
 * - allowed origin → the echoed origin;
 * - disallowed origin → null. */
export const resolveAllowOrigin = (
  origin: string | null,
  hosts: string[],
): string | null => {
  if (hosts.length === 0) return "*";
  return origin && isOriginAllowed(origin, hosts) ? origin : null;
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** A listing the visitor can add to the cart. */
export interface BookableCatalogListing {
  bookable: true;
  id: number;
  slug: string;
  name: string;
  /** Minor units (pence/cents). For pay-what-you-want this is the minimum. */
  unitPrice: number;
  /** True when a final price needs a checkout-only input (date, day count, or
   * pay-what-you-want), so the widget shows "Price set at checkout". */
  variablePrice: boolean;
}

/** A closed (inactive) listing — present only so the widget can tell the
 * visitor it is not bookable instead of navigating them to the ticket page. */
export interface ClosedCatalogListing {
  bookable: false;
  slug: string;
  name: string;
}

export type CatalogListing = BookableCatalogListing | ClosedCatalogListing;

export interface Catalog {
  origin: string;
  currency: string;
  decimalPlaces: number;
  generatedAt: string;
  listings: Record<string, CatalogListing>;
}

type VariablePriceFields = Pick<
  Listing,
  "listing_type" | "customisable_days" | "can_pay_more"
>;

/** A listing's price can't be shown without a checkout-only input when it is a
 * daily (date-required) listing, has customisable day counts, or is
 * pay-what-you-want. Answer-priced questions are intentionally not treated as
 * variable here: the widget total is explicitly indicative (a lower bound), and
 * loading every listing's question/modifier graph on each public module fetch
 * is not worth it — the checkout caveat covers the difference. */
export const isVariablePrice = (listing: VariablePriceFields): boolean =>
  listing.listing_type === "daily" ||
  listing.customisable_days ||
  listing.can_pay_more;

/** Build the catalog entry for one listing. Active listings are bookable and
 * carry pricing; closed (inactive) listings carry only slug + name.
 *
 * Note: `bookable` reflects the stable owner `active` toggle only. Time-window
 * (`closes_at`) and capacity (sold-out) states are deliberately not evaluated
 * here — like the indicative subtotal, those availability checks are resolved
 * authoritatively at the canonical ticket page. */
export const buildCatalogEntry = (listing: Listing): CatalogListing =>
  listing.active
    ? {
        bookable: true,
        id: listing.id,
        name: listing.name,
        slug: listing.slug,
        unitPrice: listing.unit_price,
        variablePrice: isVariablePrice(listing),
      }
    : { bookable: false, name: listing.name, slug: listing.slug };

/** Build the full catalog from the site's listings. Hidden/unlisted listings
 * are excluded (they must not be enumerable); every non-hidden listing —
 * active or closed — is included, keyed by slug. */
export const buildCatalog = (params: {
  origin: string;
  currency: string;
  decimalPlaces: number;
  generatedAt: string;
  listings: Listing[];
}): Catalog => ({
  currency: params.currency,
  decimalPlaces: params.decimalPlaces,
  generatedAt: params.generatedAt,
  listings: Object.fromEntries(
    params.listings
      .filter((listing) => !listing.hidden)
      .map((listing) => [listing.slug, buildCatalogEntry(listing)]),
  ),
  origin: params.origin,
});

/** Characters that are safe in JSON but unsafe verbatim in served JS: `<`
 * (could form `</script>` if inlined) and the U+2028/U+2029 line separators
 * (legal in JSON, historically illegal in JS string literals). */
const JS_UNSAFE_IN_JSON = /[<\u2028\u2029]/g;

/** Serialize the catalog as a `const CATALOG = {…};` statement safe to prepend
 * to the ES-module body. */
export const serializeCatalog = (catalog: Catalog): string =>
  `const CATALOG = ${JSON.stringify(catalog).replace(
    JS_UNSAFE_IN_JSON,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )};`;
