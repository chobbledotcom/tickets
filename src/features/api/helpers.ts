import { bookingError, parseCustomPrice } from "#booking/form.ts";
import { bookingLimiter } from "#db/booking-attempts.ts";
import { isHiddenPackageMember } from "#db/groups.ts";
import { getListingWithCountBySlug } from "#db/listings/records.ts";
import { apiError, apiResponse } from "#routes/api/cors.ts";
import type { JsonBodyReader } from "#routes/api/json-body.ts";
import { readJsonBody } from "#routes/read-json-body.ts";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp } from "#routes/url.ts";
import { FormParams } from "#shared/form-data.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { isRecord, type ListingWithCount } from "#types";

const LISTING_NOT_FOUND = "Listing not found";

/** The public booking JSON body for a booking that was created: the ticket
 * link plus any balance left to collect. Shared by the standalone and folded
 * booking paths so the two spell the contract one way. */
export const bookingSuccessResponse = (attendee: {
  remaining_balance: number;
  ticket_token: string;
}): Response =>
  apiResponse({
    booking: {
      // Outstanding balance in minor units; 0 when fully paid, positive when
      // the booking was taken without collecting payment (no provider), so
      // the integration knows the amount left to collect from the buyer.
      amountOwed: attendee.remaining_balance,
      ticketToken: attendee.ticket_token,
      ticketUrl: `/t/${attendee.ticket_token}`,
    },
  });

/** The public booking JSON body sending the buyer to the payment provider's
 * hosted checkout page to finish paying. */
export const checkoutResponse = (checkoutUrl: string): Response =>
  apiResponse({ booking: { checkoutUrl } });

/** 409 for a booking that no longer fits the remaining spots. */
export const soldOutResponse = (): Response =>
  apiError(bookingError.generic, 409);

/** Map a failed checkout-session creation to a response: the provider's own
 * message when it gave one (a 400 the buyer can act on), otherwise the
 * generic 500. */
export const checkoutFailedResponse = (error?: string): Response =>
  error ? apiError(error) : apiError(bookingError.paymentSessionFailed, 500);

/** Resolve a booking's `quantity` field from a JSON body — defaults to 1 for
 * absent/malformed values, rejects an explicit 0 (the admin-only no-quantity
 * sentinel must never be created through the public API). Shared by the
 * standalone and package booking paths so they read quantity the same way. */
export const resolvePositiveQuantity = (
  body: Record<string, unknown>,
): number | Response => {
  const parsedQuantity = parseNonNegativeInt(String(body.quantity ?? "1"));
  if (parsedQuantity === 0) {
    return apiError("Quantity must be at least 1");
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
  if (!listing.can_pay_more) return;
  const priceResult = parseCustomPrice(
    form,
    "customPrice",
    listing.unit_price,
    listing.max_price,
  );
  return priceResult.ok ? priceResult.price : apiError(priceResult.error);
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
  if (!listing?.active) return apiError(LISTING_NOT_FOUND, 404);
  return (await isHiddenPackageMember(listing.id))
    ? apiError(LISTING_NOT_FOUND, 404)
    : listing;
};

/** Parse a JSON request body, returning a 400 API response on failure */
export const parseApiJsonBody: JsonBodyReader = async (request) => {
  const body = await readJsonBody(request);
  if (!body.ok) return apiError("Invalid JSON body");
  const parsed = body.value;
  // JsonBodyReader promises a plain record. A body like `null` or `[...]` parses
  // fine but is not a record, so reject it here rather than letting it reach the
  // route's field parsing and throw further in.
  if (!isRecord(parsed)) {
    return apiError("Invalid JSON body");
  }
  return parsed;
};

/** Parse the request's JSON body and, unless it fails with a 400 response, hand
 * the parsed record to `use`. Lets a book route skip the parse-then-guard
 * boilerplate that every JSON endpoint would otherwise repeat. */
export const withApiBody = async (
  request: Request,
  use: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> => {
  const body = await parseApiJsonBody(request);
  return body instanceof Response ? body : use(body);
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
    return apiError("Too many booking attempts. Please try again later.", 429);
  }
  await bookingLimiter.record(ip);
  return null;
};

export { LISTING_NOT_FOUND };
