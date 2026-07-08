import { apiResponse } from "#routes/api/cors.ts";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp } from "#routes/url.ts";
import { parseCustomPrice } from "#shared/booking/form.ts";
import { bookingLimiter } from "#shared/db/booking-attempts.ts";
import { isHiddenPackageMember } from "#shared/db/groups.ts";
import { getListingWithCountBySlug } from "#shared/db/listings.ts";
import { FormParams } from "#shared/form-data.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";

const LISTING_NOT_FOUND = { error: "Listing not found" } as const;

/** Resolve a booking's `quantity` field from a JSON body — defaults to 1 for
 * absent/malformed values, rejects an explicit 0 (the admin-only no-quantity
 * sentinel must never be created through the public API). Shared by the
 * standalone and package booking paths so they read quantity the same way. */
export const resolvePositiveQuantity = (
  body: Record<string, unknown>,
): number | Response => {
  const parsedQuantity = parseNonNegativeInt(String(body.quantity ?? "1"));
  if (parsedQuantity === 0) {
    return apiResponse({ error: "Quantity must be at least 1" }, 400);
  }
  return parsedQuantity ?? 1;
};

/** Resolve a pay-more listing's submitted `customPrice` (from the JSON body's
 * `customPrice` field): the validated price for a `can_pay_more` listing,
 * `undefined` for a fixed-price one (nothing to parse), or a 400 response when
 * the submitted price is out of range. Shared by the standalone booking path and
 * the parent-booking path (which seeds the fold's customPrices with it) so
 * the two never parse the pay-more price differently. */
export const resolveCustomPrice = (
  listing: ListingWithCount,
  form: FormParams,
): number | undefined | Response => {
  if (!listing.can_pay_more) return undefined;
  const priceResult = parseCustomPrice(
    form,
    "customPrice",
    listing.unit_price,
    listing.max_price,
  );
  return priceResult.ok
    ? priceResult.price
    : apiResponse({ error: priceResult.error }, 400);
};

/** Look up an active listing by slug, returning a 404 response if
 * missing/inactive, or if it is the member of a HIDDEN package — such a member is
 * reachable only through its package, so the API must never expose or book it
 * standalone (mirroring the `/ticket/<member>` 404 on the web). Guards the detail,
 * availability, and book endpoints in one place. */
export const findActiveListing = async (
  slug: string,
): Promise<ListingWithCount | Response> => {
  const listing = await getListingWithCountBySlug(slug);
  if (!listing?.active) return apiResponse(LISTING_NOT_FOUND, 404);
  return (await isHiddenPackageMember(listing.id))
    ? apiResponse(LISTING_NOT_FOUND, 404)
    : listing;
};

/** Parse a JSON request body, returning a 400 API response on failure */
export const parseApiJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  try {
    return await request.json();
  } catch {
    return apiResponse({ error: "Invalid JSON body" }, 400);
  }
};

/** A route handler keyed by a single `:slug` path param — the shape every
 * `withSlugLoaded` wrapper returns to the router. Kept as a named type so the
 * listing and package wrappers expose one identical contract instead of each
 * re-spelling `(request, { slug }, server) => Promise<Response>`. */
export type SlugRouteHandler = (
  request: Request,
  params: { slug: string },
  server?: ServerContext,
) => Promise<Response>;

/** A handler that receives a slug-loaded value alongside the request — the
 * shape `withSlugLoaded` calls after the load succeeds, so each loaded surface
 * (an active listing, a bookable package) only spells how its loader yields the
 * value, not the request/server plumbing around it. */
type LoadedHandler<Loaded> = (
  request: Request,
  loaded: Loaded,
  server?: ServerContext,
) => Promise<Response>;

/** Wrap a `:slug` route handler that resolves its slug into a loaded value,
 * passing the loader's 404/error `Response` straight through when it fails. The
 * single place the load-or-respond routing is spelled, so the listing and
 * package endpoints (and any future `:slug`-loaded surface) never drift on how
 * a missing slug becomes a response. */
export const withSlugLoaded =
  <Loaded>(loader: (slug: string) => Promise<Loaded | Response>) =>
  (handler: LoadedHandler<Loaded>): SlugRouteHandler =>
  async (request, { slug }, server) => {
    const loaded = await loader(slug);
    return loaded instanceof Response
      ? loaded
      : handler(request, loaded, server);
  };

/** Look up an active listing by slug, or respond — see {@link findActiveListing}.
 * The listing detail, availability, and book endpoints route through this, so
 * the slug-lookup + 404 (and the hidden-package-member suppression) live once. */
export const withActiveListing =
  withSlugLoaded<ListingWithCount>(findActiveListing);

/** Convert JSON body fields to FormParams for validation compatibility */
export const toFormParams = (body: Record<string, unknown>): FormParams =>
  Object.entries(body).reduce((params, [key, value]) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
    return params;
  }, new FormParams());

/**
 * Throttle a booking request by client IP. The booking endpoints are
 * unauthenticated and create rows, send emails, and fire webhooks, so a flood
 * could grief capacity and spam the owner. Returns a 429 response when over the
 * limit, or null to proceed (counting this attempt).
 */
export const checkBookingRateLimit = async (
  request: Request,
  server?: ServerContext,
): Promise<Response | null> => {
  const ip = getClientIp(request, server);
  if (await bookingLimiter.isLimited(ip)) {
    return apiResponse(
      { error: "Too many booking attempts. Please try again later." },
      429,
    );
  }
  await bookingLimiter.record(ip);
  return null;
};

export { LISTING_NOT_FOUND };
