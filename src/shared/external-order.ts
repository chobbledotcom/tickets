/**
 * External order library — shared pure logic.
 *
 * Powers the `/order.js` module: deciding which external origins may load it
 * (CORS), and building the public listing catalog that is embedded in the
 * served module. Kept free of DB and settings access so it is trivially
 * testable; the handler in `src/features/public/order-js.ts` supplies the live
 * listings, currency, and request origin.
 */

import type { ListingType } from "#shared/types.ts";

/** The minimal listing shape the catalog is built from — only the columns the
 * widget serializes, so the public `/order.js` route can load it with a narrow
 * query instead of decrypting every field of every listing. */
export interface CatalogSourceListing {
  id: number;
  slug: string;
  name: string;
  unit_price: number;
  listing_type: ListingType;
  customisable_days: boolean;
  can_pay_more: boolean;
  active: boolean;
  hidden: boolean;
}

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
const matchesHostPattern = (hostname: string, pattern: string): boolean => {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
};

/** Is the request origin's host in the (non-empty) allow-list? */
const isHostnameAllowed = (origin: string | null, hosts: string[]): boolean => {
  if (!origin) return false;
  const hostname = originHostname(origin);
  if (hostname === null) return false;
  return hosts.some((pattern) => matchesHostPattern(hostname, pattern));
};

/** The `Access-Control-Allow-Origin` value to send, or null to omit the header
 * (which makes the browser refuse to evaluate the cross-origin module):
 * - empty allow-list → `*` (any site, the existing embed semantics);
 * - allowed origin → the echoed origin;
 * - disallowed or missing origin → null. */
export const resolveAllowOrigin = (
  origin: string | null,
  hosts: string[],
): string | null => {
  if (hosts.length === 0) return "*";
  return isHostnameAllowed(origin, hosts) ? origin : null;
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** A listing the visitor can add to the cart. */
export interface CatalogListing {
  id: number;
  slug: string;
  name: string;
  /** Minor units (pence/cents). For pay-what-you-want this is the minimum. */
  unitPrice: number;
  /** True when a final price needs a checkout-only input (date, day count, or
   * pay-what-you-want), so the widget shows "Price set at checkout". */
  variablePrice: boolean;
}

/** A package bundle the visitor books as a whole via its own `/ticket/<group>`
 * page. Unlike a listing it never joins the multi-listing cart (a package is
 * all-or-nothing at fixed quantities), so it carries no price — the widget links
 * straight to the package page, where the bundle is priced. */
export interface CatalogPackage {
  slug: string;
  name: string;
}

export interface Catalog {
  origin: string;
  currency: string;
  decimalPlaces: number;
  generatedAt: string;
  /** When true, the served widget emits verbose `console.debug` output so an
   * integrator can see add-to-cart enhancement, cart state, and navigation as
   * it happens. Toggled per request with `?debug=true` on `/order.js`. */
  debug: boolean;
  listings: Record<string, CatalogListing>;
  /** Bookable package groups keyed by group slug. A `data-add-listing` link to
   * one of these navigates straight to `/ticket/<slug>` instead of adding a cart
   * line. Empty when the site has no bookable packages. */
  packages: Record<string, CatalogPackage>;
}

type VariablePriceFields = Pick<
  CatalogSourceListing,
  "listing_type" | "customisable_days" | "can_pay_more"
>;

/** A listing's price can't be shown without a checkout-only input when it is a
 * daily (date-required) listing, has customisable day counts, or is
 * pay-what-you-want. Answer-priced questions are intentionally not treated as
 * variable here: the widget total is explicitly indicative (a lower bound), and
 * loading every listing's question/modifier graph on each public module fetch
 * is not worth it — the checkout caveat covers the difference. */
const isVariablePrice = (listing: VariablePriceFields): boolean =>
  listing.listing_type === "daily" ||
  listing.customisable_days ||
  listing.can_pay_more;

const buildCatalogEntry = (listing: CatalogSourceListing): CatalogListing => ({
  id: listing.id,
  name: listing.name,
  slug: listing.slug,
  unitPrice: listing.unit_price,
  variablePrice: isVariablePrice(listing),
});

/** Build the catalog from the site's listings. Only **active, non-hidden**
 * listings are included — the same set the public `/order` and `/listings`
 * pages expose, and the only set whose `/ticket/:slug` page does not 404
 * (`withActiveListings` drops inactive listings). Hidden listings must not be
 * enumerable; inactive listings 404 by direct URL today, so embedding their
 * slug/name would leak otherwise-private names. A `data-add-listing` to a
 * listing outside this set is simply not enhanced and keeps its plain `href`. */
export const buildCatalog = (params: {
  origin: string;
  currency: string;
  decimalPlaces: number;
  generatedAt: string;
  debug: boolean;
  listings: CatalogSourceListing[];
  /** Bookable package groups (slug + decrypted name). The caller has already
   * gated these to whole-bundle-bookable, non-hidden packages — the same set
   * `/listings` and `/order` advertise. */
  packages?: CatalogPackage[];
}): Catalog => ({
  currency: params.currency,
  debug: params.debug,
  decimalPlaces: params.decimalPlaces,
  generatedAt: params.generatedAt,
  listings: Object.fromEntries(
    params.listings
      .filter((listing) => listing.active && !listing.hidden)
      .map((listing) => [listing.slug, buildCatalogEntry(listing)]),
  ),
  origin: params.origin,
  packages: Object.fromEntries(
    (params.packages ?? []).map((pkg) => [
      pkg.slug,
      { name: pkg.name, slug: pkg.slug },
    ]),
  ),
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
