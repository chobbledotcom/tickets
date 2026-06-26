/**
 * Public JSON API routes
 *
 * Exposes listing listing, details, availability, and booking
 * with the same data and validation as the web UI.
 */

import { compact, filter, pipe, sumOf } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { classifyForDiscovery } from "#routes/public/discovery.ts";
import { parseCustomPrice } from "#routes/public/ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "#routes/public/ticket-listings.ts";
import {
  anyChildListing,
  buildRegistrationItems,
  checkAvailability,
  constrainParentDailyDates,
  createFreeReservation,
  foldSelectedChildren,
  getTicketContext,
  parentRequiresChild,
} from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { jsonResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import { getBaseUrl, getClientIp } from "#routes/url.ts";
import { processBooking } from "#shared/booking.ts";
import { owedOrderForLedger } from "#shared/checkout-ledger.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { getAvailableDates } from "#shared/dates.ts";
import {
  getGroupRemainingByListingId,
  getGroupRemainingForListing,
} from "#shared/db/attendees/capacity.ts";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  isBookingRateLimited,
  recordBookingAttempt,
} from "#shared/db/booking-attempts.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import {
  getAllListings,
  getListingWithCountBySlug,
} from "#shared/db/listings.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import { sortListings } from "#shared/sort-listings.ts";
import {
  availableDayCounts,
  type ContactInfo,
  dayPriceFor,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  parseNonNegativeInt,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import {
  extractContact,
  mergeListingFields,
  tryValidateTicketFields,
} from "#templates/fields.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";

// =============================================================================
// CORS
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "86400",
};

/** JSON response with CORS headers */
const apiResponse = (data: unknown, status = 200): Response => {
  const response = jsonResponse(data, status);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
};

/** CORS preflight response */
const handleOptions = (): Response =>
  new Response(null, { headers: CORS_HEADERS, status: 204 });

// =============================================================================
// Public listing shape
// =============================================================================

export type PublicListing = {
  name: string;
  slug: string;
  description: string;
  date: string | null;
  location: string | null;
  imageUrl: string | null;
  unitPrice: number;
  canPayMore: boolean;
  maxPrice: number;
  nonTransferable: boolean;
  purchaseOnly: boolean;
  fields: string;
  listingType: string;
  /** True when visitors choose how many days to book; price comes from
   * `dayPrices` rather than `unitPrice`. */
  customisableDays: boolean;
  /** Offered day counts mapped to their price (minor units). Present only for
   * customisable-days listings. */
  dayPrices?: Record<number, number>;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
  availableDates?: string[];
  /** The required children a buyer must choose from when booking this listing as
   * a parent (per-unit; the chosen quantities total the parent quantity). Present
   * only on the detail endpoint for a parent listing, so a client knows which
   * child slugs, prices, and inputs are valid before calling the booking POST. */
  children?: PublicListing[];
};

/** `groupRemaining`, when defined, clamps the displayed sold-out state to
 * the group's combined cap. The sold-out/max-purchasable core is the shared
 * {@link buildTicketListing} (the same availability projection the web cards and
 * the parent-sold-out discovery path use), so the API and the web never compute
 * "is this listing bookable, and how many?" differently. */
export const toPublicListing = (
  listing: ListingWithCount,
  closed: boolean,
  availableDates: string[] | undefined,
  groupRemaining: number | undefined,
): PublicListing => {
  const { isSoldOut, maxPurchasable } = buildTicketListing(
    listing,
    closed,
    groupRemaining,
  );

  const result: PublicListing = {
    canPayMore: listing.can_pay_more,
    customisableDays: listing.customisable_days,
    date: listing.date || null,
    description: listing.description,
    fields: listing.fields,
    imageUrl: listing.image_url || null,
    isClosed: closed,
    isSoldOut,
    listingType: listing.listing_type,
    location: listing.location || null,
    maxPrice: listing.max_price,
    maxPurchasable,
    name: listing.name,
    nonTransferable: listing.non_transferable,
    purchaseOnly: listing.purchase_only,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  };

  if (availableDates) {
    result.availableDates = availableDates;
  }

  if (listing.customisable_days) {
    // availableDayCounts only yields priced counts, so dayPriceFor is non-null.
    result.dayPrices = Object.fromEntries(
      availableDayCounts(listing).map((n) => [n, dayPriceFor(listing, n)!]),
    );
  }

  return result;
};

/** Resolve a listing row to its public shape, filling in the closed flag and the
 * group-remaining clamp from the listing itself (the caller supplies only the
 * availableDates, which differ per surface). The single place the API turns a row
 * into a {@link PublicListing} with its live availability. */
const toResolvedPublicListing = async (
  listing: ListingWithCount,
  availableDates: string[] | undefined,
): Promise<PublicListing> =>
  toPublicListing(
    listing,
    isRegistrationClosed(listing),
    availableDates,
    await getGroupRemainingForListing(listing),
  );

/** Map a parent's required children to a per-child result, or null when the
 * listing is not a parent (no child edges) so the caller can omit the field. The
 * one place the API loads a parent's children for a response, so the detail and
 * availability surfaces never drift on which children they report. */
const mapParentChildren = async <T>(
  parent: ListingWithCount,
  map: (child: ListingWithCount) => T | Promise<T>,
): Promise<T[] | null> => {
  const children =
    (await getChildrenForParents([parent.id])).get(parent.id) ?? [];
  return children.length === 0 ? null : Promise.all(children.map(map));
};

/** The public shape of each required child of a parent, for the detail endpoint.
 * Children carry their own price/inputs/availability so a client can pick a valid
 * one (and pay the right amount) before booking; a daily child reports its own
 * bookable start dates. Empty array for a non-parent listing.
 *
 * An inactive (`active=0`) child is omitted (Fix 2): `toPublicListing` doesn't
 * expose `active`, so an inactive child with spare capacity would otherwise read
 * `isClosed:false` with a positive `maxPurchasable` while the booking fold
 * rejects it (`childActive` in shared.tsx) — so the detail endpoint must not
 * advertise a child the booking POST refuses, the same `active` predicate the
 * availability endpoint (`buildChildAvailability`) already applies. */
const buildChildPublicListings = async (
  parent: ListingWithCount,
): Promise<PublicListing[]> =>
  compact(
    (await mapParentChildren(parent, async (child) =>
      child.active
        ? toResolvedPublicListing(
            child,
            child.listing_type === "daily"
              ? getAvailableDates(child, await getActiveHolidays())
              : undefined,
          )
        : null,
    )) ?? [],
  );

// =============================================================================
// Helpers
// =============================================================================

const LISTING_NOT_FOUND = { error: "Listing not found" } as const;

/** Look up an active listing by slug, returning a 404 response if missing/inactive */
const findActiveListing = async (
  slug: string,
): Promise<ListingWithCount | Response> => {
  const listing = await getListingWithCountBySlug(slug);
  return listing?.active ? listing : apiResponse(LISTING_NOT_FOUND, 404);
};

/** Parse a JSON request body, returning a 400 API response on failure */
const parseApiJsonBody = async (
  request: Request,
): Promise<Record<string, unknown> | Response> => {
  try {
    return await request.json();
  } catch {
    return apiResponse({ error: "Invalid JSON body" }, 400);
  }
};

/** Wrap a handler that needs an active listing — handles slug lookup + 404 */
const withActiveListing =
  (
    handler: (
      request: Request,
      listing: ListingWithCount,
      server?: ServerContext,
    ) => Promise<Response>,
  ) =>
  async (
    request: Request,
    { slug }: { slug: string },
    server?: ServerContext,
  ): Promise<Response> => {
    const result = await findActiveListing(slug);
    return result instanceof Response
      ? result
      : handler(request, result, server);
  };

// =============================================================================
// Parent/child discovery guard (Fix 2)
// =============================================================================

/** How a single listing should read on the detail/availability surfaces under
 * the parent/child feature: a child is not standalone-bookable (404, matching
 * how the web booking page rejects a child slug), and a parent with no bookable
 * child reads sold out / unavailable (invariant I6). */
type ListingDiscoveryState = { isChild: boolean; isSoldOutParent: boolean };

/** Classify one listing for the detail/availability endpoints, reusing the same
 * discovery classification the web surfaces use (child suppression + parent
 * sold-out). Flag-off (or a plain listing) yields the neutral state, so existing
 * endpoints are unchanged until parents ship. */
const listingDiscoveryState = async (
  listing: ListingWithCount,
): Promise<ListingDiscoveryState> => {
  const { childIds, soldOutParentIds } = await classifyForDiscovery([listing]);
  return {
    isChild: childIds.has(listing.id),
    isSoldOutParent: soldOutParentIds.has(listing.id),
  };
};

// =============================================================================
// Handlers
// =============================================================================

/** GET /api/listings — list active, non-hidden listings */
const handleListListings = async (): Promise<Response> => {
  const allListings = await getAllListings();
  const holidays = await getActiveHolidays();
  const visibleListings = pipe(
    filter((e: ListingWithCount) => e.active && !e.hidden),
    (active) => sortListings(active, holidays),
  )(allListings);
  // A child is never standalone-bookable (invariant I3), so omit children from
  // the discovery list — a client must not find one here and then hit the
  // booking 400 (Fix 2, parents.md "Discovery responses"). A parent with no
  // bookable child is sold out (invariant I6): its OWN row capacity ignores its
  // children, so the list must project it to sold-out / not-bookable to stay
  // consistent with the detail/availability endpoints (Fix 3) — otherwise a
  // client lists it as bookable then hits the parent-sold-out outcome at detail.
  const { childIds, soldOutParentIds } =
    await classifyForDiscovery(visibleListings);
  const bookableListings = visibleListings.filter((e) => !childIds.has(e.id));
  const groupRemaining = await getGroupRemainingByListingId(bookableListings);
  const listings = bookableListings.map((e) => {
    const publicListing = toPublicListing(
      e,
      isRegistrationClosed(e),
      undefined,
      groupRemaining.get(e.id),
    );
    return soldOutParentIds.has(e.id)
      ? { ...publicListing, isSoldOut: true, maxPurchasable: 0 }
      : publicListing;
  });
  return apiResponse({ listings });
};

/** GET /api/listings/:slug — single listing detail */
const handleGetListing = withActiveListing(async (_request, listing) => {
  const { isChild, isSoldOutParent } = await listingDiscoveryState(listing);
  // A child is not standalone-bookable (invariant I3), so its detail endpoint is
  // a 404 — the same not-bookable outcome the web booking page gives a child
  // slug (Fix 2).
  if (isChild) return apiResponse(LISTING_NOT_FOUND, 404);
  let availableDates: string[] | undefined;
  if (listing.listing_type === "daily") {
    const holidays = await getActiveHolidays();
    // A daily parent's API dates must match what the web selector offers: a date
    // no required child can serve (for the inherited span) is removed from the
    // parent's own calendar, so the API never advertises a date the fold rejects
    // (Fix 4). For a non-parent daily listing this is a no-op.
    availableDates = await constrainParentDailyDates(
      listing,
      getAvailableDates(listing, holidays),
      holidays,
    );
  }
  const [publicListing, children] = await Promise.all([
    toResolvedPublicListing(listing, availableDates),
    buildChildPublicListings(listing),
  ]);
  // A parent advertises its required children so a client can choose a valid one
  // (slug, price, inputs, dates) before the booking POST.
  const withChildren =
    children.length > 0 ? { ...publicListing, children } : publicListing;
  // A parent with no bookable child is sold out (invariant I6); the route
  // listing's own capacity ignores its children, so project the discovery
  // sold-out outcome onto the response rather than advertising it as bookable.
  return apiResponse({
    listing: isSoldOutParent
      ? { ...withChildren, isSoldOut: true, maxPurchasable: 0 }
      : withChildren,
  });
});

/** Per-child availability for a parent's required children at a date/quantity, or
 * null when the listing is not a parent. A daily child takes the parent's date;
 * a standard child is date-less. An inactive (`active=0`) or registration-closed
 * child reports `available: false` regardless of spare capacity (Fix 1): the
 * booking fold rejects it (`childActive`/`childOpen` in shared.tsx), so reusing
 * the same `active` + `isRegistrationClosed` predicates the fold uses keeps the
 * availability endpoint from advertising a child the booking POST would refuse. */
const buildChildAvailability = (
  parent: ListingWithCount,
  date: string | undefined,
  quantity: number,
): Promise<{ slug: string; available: boolean }[] | null> =>
  mapParentChildren(parent, async (child) => ({
    available:
      child.active &&
      !isRegistrationClosed(child) &&
      (await hasAvailableSpots(
        child.id,
        quantity,
        child.listing_type === "daily" ? (date ?? null) : null,
        child.duration_days,
      )),
    slug: child.slug,
  }));

/** GET /api/listings/:slug/availability — check if spots are available */
const handleCheckAvailability = withActiveListing(async (request, listing) => {
  const { isChild, isSoldOutParent } = await listingDiscoveryState(listing);
  // A child is not standalone-bookable (invariant I3) — 404, consistent with the
  // detail endpoint and the web booking page (Fix 2).
  if (isChild) return apiResponse(LISTING_NOT_FOUND, 404);
  // A parent with no bookable child is sold out (invariant I6): its own capacity
  // ignores its children, so report it unavailable rather than letting the
  // route listing's standalone spots advertise it as bookable.
  if (isSoldOutParent) return apiResponse({ available: false });
  const url = new URL(request.url);
  const quantity =
    parseNonNegativeInt(url.searchParams.get("quantity") ?? "1") ?? 1;
  const date = url.searchParams.get("date") || undefined;
  // A daily parent's availability must honour the child-date union (Fix 1): the
  // route listing's own capacity ignores its children, so it could answer
  // `available: true` for a date the (child-constrained) detail endpoint omits
  // and the booking fold then rejects. Constrain the requested date through the
  // same `constrainParentDailyDates` union the detail endpoint uses; a date no
  // required child can serve for the inherited span is unavailable. For a
  // non-parent daily listing (no child edges) this is a no-op.
  if (listing.listing_type === "daily" && date) {
    const holidays = await getActiveHolidays();
    const childServableDates = await constrainParentDailyDates(
      listing,
      getAvailableDates(listing, holidays),
      holidays,
    );
    if (!childServableDates.includes(date)) {
      return apiResponse({ available: false });
    }
  }
  const available = await hasAvailableSpots(
    listing.id,
    quantity,
    date,
    listing.duration_days,
  );
  // For a parent, also report each required child's availability for the chosen
  // date/quantity (a daily child inherits the parent's date; a standard child is
  // date-less), so a client can pick a child that can actually serve the booking
  // rather than discovering it only when the booking POST rejects it.
  const childAvailability = await buildChildAvailability(
    listing,
    date,
    quantity,
  );
  return apiResponse(
    childAvailability === null
      ? { available }
      : { available, children: childAvailability },
  );
});

/** Convert JSON body fields to FormParams for validation compatibility */
const toFormParams = (body: Record<string, unknown>): FormParams =>
  Object.entries(body).reduce((params, [key, value]) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
    return params;
  }, new FormParams());

/** Map a BookingResult to an API JSON response */
const bookingResultToResponse = (
  result: import("#shared/booking.ts").BookingResult,
): Response => {
  switch (result.type) {
    case "success":
      return apiResponse({
        booking: {
          // Outstanding balance in minor units; 0 when fully paid, positive when
          // the booking was taken without collecting payment (no provider), so
          // the integration knows the amount left to collect from the buyer.
          amountOwed: result.attendee.remaining_balance,
          ticketToken: result.attendee.ticket_token,
          ticketUrl: `/t/${result.attendee.ticket_token}`,
        },
      });
    case "checkout":
      return apiResponse({ booking: { checkoutUrl: result.checkoutUrl } });
    case "sold_out":
      return apiResponse({ error: "Sorry, not enough spots available" }, 409);
    case "checkout_failed":
      return result.error
        ? apiResponse({ error: result.error }, 400)
        : apiResponse({ error: "Failed to create payment session" }, 500);
    case "creation_failed":
      return result.reason === "capacity_exceeded"
        ? apiResponse({ error: "Sorry, not enough spots available" }, 409)
        : apiResponse({ error: "Registration failed. Please try again." }, 500);
  }
};

/**
 * Throttle a booking request by client IP. This endpoint is unauthenticated and
 * creates rows, sends emails, and fires webhooks, so a flood could grief
 * capacity and spam the owner. Returns a 429 response when over the limit, or
 * null to proceed (counting this attempt).
 */
const checkBookingRateLimit = async (
  request: Request,
  server?: ServerContext,
): Promise<Response | null> => {
  const ip = getClientIp(request, server);
  if (await isBookingRateLimited(ip)) {
    return apiResponse(
      { error: "Too many booking attempts. Please try again later." },
      429,
    );
  }
  await recordBookingAttempt(ip);
  return null;
};

/**
 * Resolve and validate the booking date for daily listings (a no-op for other
 * listing types). Returns the submitted date, null for non-daily listings, or a
 * 400 response when the date is missing or unavailable.
 */
const resolveBookingDate = async (
  listing: ListingWithCount,
  body: Record<string, unknown>,
): Promise<string | null | Response> => {
  if (listing.listing_type !== "daily") return null;
  const submittedDate = String(body.date ?? "");
  const availableDates = getAvailableDates(listing, await getActiveHolidays());
  if (!submittedDate || !availableDates.includes(submittedDate)) {
    return apiResponse({ error: "Please select a valid date" }, 400);
  }
  return submittedDate;
};

/** Resolve a booking's quantity (clamped to the listing's per-order max) and its
 * date (validated for daily listings), or a 400 response for an invalid date.
 * Shared by the standalone and parent booking paths. */
const resolveQuantityAndDate = async (
  listing: ListingWithCount,
  body: Record<string, unknown>,
): Promise<{ quantity: number; date: string | null } | Response> => {
  // A submitted quantity of exactly 0 must NOT become a one-ticket booking — a
  // quantity-0 line is the admin-only no-quantity sentinel and is never created
  // through the public API. Malformed/absent values keep the lenient default of 1;
  // only an explicit 0 is rejected (parseNonNegativeInt accepts 0, where
  // parsePositiveInt would mask it as null). Resolving it here applies the guard
  // to both the standalone and parent/child booking paths.
  const parsedQuantity = parseNonNegativeInt(String(body.quantity ?? "1"));
  if (parsedQuantity === 0) {
    return apiResponse({ error: "Quantity must be at least 1" }, 400);
  }
  const quantity = Math.min(parsedQuantity ?? 1, listing.max_quantity);
  const date = await resolveBookingDate(listing, body);
  return date instanceof Response ? date : { date, quantity };
};

/** Resolve a pay-more listing's submitted `customPrice` (from the JSON body's
 * `customPrice` field): the validated price for a `can_pay_more` listing,
 * `undefined` for a fixed-price one (nothing to parse), or a 400 response when
 * the submitted price is out of range. Shared by the standalone booking path and
 * the parent-booking path (which seeds the fold's customPrices with it, Fix 4) so
 * the two never parse the pay-more price differently. */
const resolveCustomPrice = (
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

/** One child selection in a parent booking body: a child slug and how many of
 * the parent's units take it (the chosen quantities total the parent quantity),
 * with an optional pay-more price. */
type ApiChildSelection = {
  slug: string;
  quantity: number;
  customPrice?: number;
};

/** Parse the `children` array of a parent booking body. An absent field yields an
 * empty selection (the fold auto-fills a sole child, or rejects a multi-child
 * parent with a "choose more" error); a present-but-malformed field — not an
 * array, or an entry missing a non-empty slug or a positive quantity — yields null
 * so the caller returns a 400. */
const parseApiChildSelections = (
  body: Record<string, unknown>,
): ApiChildSelection[] | null => {
  const raw = body.children ?? [];
  if (!Array.isArray(raw)) return null;
  const selections: ApiChildSelection[] = [];
  for (const entry of raw) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const slug = String(record.slug ?? "");
    const quantity = parsePositiveInt(String(record.quantity ?? ""));
    if (slug === "" || quantity === null) return null;
    selections.push({
      quantity,
      slug,
      ...(record.customPrice !== undefined
        ? { customPrice: Number(record.customPrice) }
        : {}),
    });
  }
  return selections;
};

/** Translate a parent booking's contact body + resolved child selections into the
 * `child_qty_*` / `child_price_*` form the shared fold reads, resolving each
 * submitted slug against the parent's actual children (repeated slugs sum).
 * Returns the populated form, or a 400 response naming a slug that is not a child
 * of this parent, or a 400 when repeated entries for one child disagree on the
 * pay-more `customPrice` (Fix 4). */
const buildParentFoldForm = (
  body: Record<string, unknown>,
  parentId: number,
  childBySlug: Map<string, TicketListing>,
  selections: ApiChildSelection[],
): FormParams | Response => {
  const form = toFormParams(body);
  const qtyByChild = new Map<number, number>();
  // The fold stores ONE `child_price_*` per child for its whole quantity, so two
  // entries for the same child specifying different `customPrice` values (or one
  // specifying a price and another leaving it default) can't both be honoured —
  // a `form.set` would silently let the last entry's price win and book every
  // unit at it (Fix 4). Track each child's submitted price and reject a conflict
  // with a 400 rather than charging the wrong amount; a single aggregated entry
  // (or repeats agreeing on the price) is accepted.
  const priceByChild = new Map<number, number | undefined>();
  for (const selection of selections) {
    const child = childBySlug.get(selection.slug);
    if (!child) {
      return apiResponse(
        { error: `'${selection.slug}' is not a child of this listing.` },
        400,
      );
    }
    const childId = child.listing.id;
    if (
      priceByChild.has(childId) &&
      priceByChild.get(childId) !== selection.customPrice
    ) {
      return apiResponse(
        {
          error: `Conflicting prices for '${selection.slug}'. Send one entry per child with a single price.`,
        },
        400,
      );
    }
    priceByChild.set(childId, selection.customPrice);
    qtyByChild.set(
      childId,
      (qtyByChild.get(childId) ?? 0) + selection.quantity,
    );
    if (selection.customPrice !== undefined) {
      form.set(
        `child_price_${parentId}_${childId}`,
        String(selection.customPrice),
      );
    }
  }
  for (const [childId, qty] of qtyByChild) {
    form.set(`child_qty_${parentId}_${childId}`, String(qty));
  }
  return form;
};

/** The price (minor units) of a folded multi-item order. */
const foldedOrderTotal = (items: CheckoutItem[]): number =>
  sumOf((item: CheckoutItem) => item.unitPrice * item.quantity)(items);

/** The folded multi-item order a completed parent booking creates: the expanded
 * listing set + quantity/custom-price maps + the resolved shared day count, plus
 * whether any line is customisable (so the checkout intent carries the folded
 * `dayCount` for the webhook to reprice by, Fix 3). */
type FoldedOrder = {
  listings: TicketListing[];
  quantities: Map<number, number>;
  customPrices: Map<number, number>;
  dayCount: number;
  hasCustomisable: boolean;
};

/** Charge or create a folded parent+children order. Paid (with a provider): a
 * multi-item checkout session whose webhook creates and pairs the rows. Free (or
 * provider-less paid): all rows created atomically — all-or-nothing — with the
 * full value recorded as owed when no provider is configured.
 *
 * `parentThankYouUrl` is the single parent's configured redirect: folding a child
 * makes the order multi-listing, so the success handler's single-listing-id
 * derivation would otherwise drop it. We carry it on the paid intent so the
 * success page honours it (Fix 1) — mirroring the web folded-parent path
 * (`ticket-submit.ts`), which sets `intent.thankYouUrl` only once a child was
 * actually folded in. */
const completeFoldedBooking = async (
  request: Request,
  contact: ContactInfo,
  date: string | null,
  fold: FoldedOrder,
  parentThankYouUrl: string,
): Promise<Response> => {
  const items = buildRegistrationItems(
    fold.listings,
    fold.quantities,
    fold.customPrices,
    fold.dayCount,
  );
  const total = foldedOrderTotal(items);
  // Carry the chosen span only when a folded line is customisable, so the webhook
  // reprices and dates the booking by day count rather than defaulting to 1 (Fix
  // 3) — mirroring the web path's conditional `dayCount` on its intent.
  const intent: CheckoutIntent = {
    ...contact,
    date,
    items,
    ...(fold.hasCustomisable ? { dayCount: fold.dayCount } : {}),
    // Carry the parent's thank-you URL only once a child was actually folded in
    // (the order gained a listing): a multi-listing order can't recover it from
    // the booked listing ids, while a degenerate single-listing fold still
    // resolves the same URL by the success handler's default rule (Fix 1).
    ...(parentThankYouUrl && fold.listings.length > 1
      ? { thankYouUrl: parentThankYouUrl }
      : {}),
  };
  if (isPaymentsEnabled() && total > 0) {
    // Reject a folded order whose parent or any child has exhausted capacity
    // before creating a checkout session (Fix 5): the web paid path runs the same
    // `checkAvailability` preflight, so without it the API would hand back a
    // checkout URL for a sold-out order the webhook then can't create.
    const available = await checkAvailability(
      fold.listings,
      fold.quantities,
      date,
      fold.dayCount,
    );
    if (!available) {
      return apiResponse({ error: "Sorry, not enough spots available" }, 409);
    }
    const provider = (await getActivePaymentProvider())!;
    const baseUrl = getBaseUrl(request);
    const result = await provider.createCheckoutSession(intent, baseUrl);
    if (!result) {
      return apiResponse({ error: "Failed to create payment session" }, 500);
    }
    return "error" in result
      ? apiResponse({ error: result.error }, 400)
      : apiResponse({ booking: { checkoutUrl: result.checkoutUrl } });
  }
  // Free, or provider-less paid (owes the full value). An owed order must record
  // its gross sale legs in the ledger at creation — the outstanding balance
  // projects from it — so build the zeroed-total owed order the web free path
  // uses; a genuinely free order (payments enabled, total 0) owes nothing and
  // posts no legs.
  const remainingBalance = isPaymentsEnabled() ? 0 : total;
  const reservation = await createFreeReservation({
    contact,
    date,
    dayCount: fold.dayCount,
    ledgerOrder:
      remainingBalance > 0
        ? owedOrderForLedger(priceCheckout({ ...intent, feeSubtotal: 0 }))
        : null,
    listings: fold.listings,
    modifierUsages: [],
    quantities: fold.quantities,
    remainingBalance,
  });
  if (!reservation.success) {
    return apiResponse({ error: "Sorry, not enough spots available" }, 409);
  }
  // Notify only after stock is committed, exactly like the standalone API booking
  // (`processBooking`) and the web free path (`handleFreePath`) do after
  // `createFreeReservation` (Fix 3): without this the folded free/provider-less
  // parent booking silently skips the confirmation email, registration webhook,
  // and activity log every other booking path fires.
  await logAndNotifyRegistration(reservation.entries);
  const attendee = reservation.entries[0]!.attendee;
  return apiResponse({
    booking: {
      amountOwed: attendee.remaining_balance,
      ticketToken: attendee.ticket_token,
      ticketUrl: `/t/${attendee.ticket_token}`,
    },
  });
};

/**
 * Book a parent listing through the JSON API with its required children (per-unit
 * selection, mirroring the web fold): resolve the chosen child slugs, fold them
 * into a multi-item order, validate contact fields against the merged parent+child
 * requirements (a paid child can add Square's email), then charge (multi-item
 * checkout) or create all rows all-or-nothing (free). The parent/child pairing is
 * recomputed at creation, so the parent and its children are stored linked.
 */
const processParentApiBooking = async (
  request: Request,
  listing: ListingWithCount,
  body: Record<string, unknown>,
  quantity: number,
  date: string | null,
): Promise<Response> => {
  // The API has no day-count input, so a customisable parent (priced by a chosen
  // span its children inherit) can't be booked here — like a customisable
  // standalone listing.
  if (listing.customisable_days) {
    return apiResponse(
      { error: "This listing must be booked through the website." },
      400,
    );
  }
  const selections = parseApiChildSelections(body);
  if (selections === null) {
    return apiResponse(
      {
        error:
          "Provide a `children` array of { slug, quantity } totalling the booked quantity.",
      },
      400,
    );
  }

  // Build the parent's ticket context (children + availability), then map the
  // submitted child slugs onto the fold's per-child quantity form.
  const [parentListing] = await buildTicketListingsWithGroupCapacity([listing]);
  const sharedCtx = await getTicketContext([parentListing!]);
  const ctx: TicketCtx = {
    ...sharedCtx,
    listings: [parentListing!],
    slugs: [listing.slug],
  };
  // parentRequiresChild guaranteed ≥1 edge and listing deletes cascade their
  // edges, so a parent here always has a children entry in the context.
  const children = ctx.childrenByParentId.get(listing.id)!;
  const childBySlug = new Map(children.map((c) => [c.listing.slug, c]));
  const form = buildParentFoldForm(body, listing.id, childBySlug, selections);
  if (form instanceof Response) return form;

  // A pay-more PARENT carries its own custom price (Fix 4): without seeding it the
  // fold prices the parent at its `unit_price` and undercharges. Resolve it the
  // same way the standalone path does and seed the fold's customPrices map; a
  // fixed-price parent contributes nothing here.
  const parentCustomPrice = resolveCustomPrice(listing, form);
  if (parentCustomPrice instanceof Response) return parentCustomPrice;
  const customPrices = new Map<number, number>();
  if (parentCustomPrice !== undefined) {
    customPrices.set(listing.id, parentCustomPrice);
  }

  const fold = await foldSelectedChildren(ctx, form, {
    customPrices,
    date,
    dayCount: 1,
    hasCustomisable: false,
    quantities: new Map([[listing.id, quantity]]),
  });
  if (!fold.ok) return apiResponse({ error: fold.error }, 400);

  // Validate contact fields against the MERGED parent+child requirements and the
  // folded paid-ness (a free parent with a paid child still needs Square's email).
  const valResult = tryValidateTicketFields(
    form,
    mergeListingFields(fold.listings.map((e) => e.listing.fields)),
    (msg) => apiResponse({ error: msg }, 400),
    fold.listings.some((e) => isPaidListing(e.listing)),
  );
  if (valResult instanceof Response) return valResult;
  return completeFoldedBooking(
    request,
    extractContact(valResult),
    date,
    fold,
    // The fold always starts from this single parent, so its configured
    // thank-you URL is the one a folded order would otherwise drop (Fix 1).
    listing.thank_you_url,
  );
};

/** POST /api/listings/:slug/book — create a booking */
const handleBook = withActiveListing(async (request, listing, server) => {
  // A booking can never start from a child (invariant I3): a child is only
  // bookable through one of its parents, so reject it as a direct API entry.
  if (await anyChildListing([listing.id])) {
    return apiResponse(
      { error: "This listing must be booked through its parent listing." },
      400,
    );
  }

  const limited = await checkBookingRateLimit(request, server);
  if (limited) return limited;

  if (isRegistrationClosed(listing)) {
    return apiResponse({ error: "Registration is closed" }, 400);
  }

  const bodyOrError = await parseApiJsonBody(request);
  if (bodyOrError instanceof Response) return bodyOrError;
  const body = bodyOrError;

  // Resolve the booking quantity + date once, shared by the parent and standalone
  // paths so neither re-derives it (and the JSON contract reads one way).
  const qtyAndDate = await resolveQuantityAndDate(listing, body);
  if (qtyAndDate instanceof Response) return qtyAndDate;
  const { quantity, date } = qtyAndDate;

  // A parent requires the buyer to choose its children (invariant I1): fold the
  // submitted `children` into a multi-item order rather than booking the parent
  // alone, which would bypass the gate.
  if (await parentRequiresChild(listing.id)) {
    return processParentApiBooking(request, listing, body, quantity, date);
  }

  // Customisable-days listings are priced by a chosen day count, which this
  // endpoint doesn't accept — booking them here would charge the wrong amount,
  // so they must be booked through the website form.
  if (listing.customisable_days) {
    return apiResponse(
      { error: "This listing must be booked through the website." },
      400,
    );
  }

  const form = toFormParams(body);

  // Validate fields using the same form validation as the web
  const paid = isPaidListing(listing);
  const valResult = tryValidateTicketFields(
    form,
    listing.fields,
    (msg) => apiResponse({ error: msg }, 400),
    paid,
  );
  if (valResult instanceof Response) return valResult;
  const values = valResult;

  // Parse custom price for pay-more listings
  const customUnitPrice = resolveCustomPrice(listing, form);
  if (customUnitPrice instanceof Response) return customUnitPrice;

  const contact = extractContact(values);
  return bookingResultToResponse(
    await processBooking(
      listing,
      contact,
      quantity,
      date,
      getBaseUrl(request),
      customUnitPrice,
    ),
  );
});

// =============================================================================
// Route definitions
// =============================================================================

export const apiRoutes = defineRoutes({
  "GET /api/listings": handleListListings,
  "GET /api/listings/:slug": handleGetListing,
  "GET /api/listings/:slug/availability": handleCheckAvailability,
  "OPTIONS /api/listings": handleOptions,
  "OPTIONS /api/listings/:slug": handleOptions,
  "OPTIONS /api/listings/:slug/availability": handleOptions,
  "OPTIONS /api/listings/:slug/book": handleOptions,
  "POST /api/listings/:slug/book": handleBook,
});

export const routeApi = createRouter(apiRoutes);
