/**
 * Payment flow, availability checks, and free registration
 */

import { compact } from "#fp";
import {
  checkoutResponse,
  errorRedirect,
  notFoundResponse,
} from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { isListingParentsEnabled } from "#shared/config.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type {
  CreateAttendeeResult,
  LineBooking,
} from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  ensureAllBookings,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getChildListingIds } from "#shared/db/listing-parents.ts";
import { getListingsBySlugsBatch } from "#shared/db/listings.ts";
import {
  getOptionalAddOns,
  hasPromoCodeModifiers,
} from "#shared/db/modifier-resolve.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import type { EmailEntry } from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { logDebug } from "#shared/logger.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import {
  type ContactInfo,
  dayPriceFor,
  type Group,
  normalizeDurationDays,
} from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type { TicketListing } from "#templates/public.tsx";
import { formatAtomicError, listingsWithQuantity } from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type {
  AsyncHandler,
  ListingQty,
  TicketCtx,
  TicketSharedContext,
} from "./types.ts";

/** Try to redirect to checkout, or return error using provided handler.
 * When in iframe mode, returns a popup page instead of redirect since Stripe cannot run in iframes. */
export const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  errorHandler: () => T,
): Response | T => {
  if (!sessionUrl) return errorHandler();
  return checkoutResponse(sessionUrl);
};

/** Get active payment provider or return an error response */
export const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
  ) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error.
 * When in iframe mode, opens checkout in a popup window instead of redirect. */
export const runCheckoutFlow = (
  label: string,
  request: Request,
  createSession: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
    baseUrl: string,
  ) => Promise<import("#shared/payments.ts").CheckoutSessionResult>,
  onError: (msg: string, status: number) => Response,
): Promise<Response> => {
  logDebug("Payment", `Starting ${label} checkout`);
  return withPaymentProvider(
    () => {
      logDebug(
        "Payment",
        `No payment provider configured for ${label} checkout`,
      );
      return onError(
        "Payments are not configured. Please contact the administrator.",
        500,
      );
    },
    async (provider) => {
      logDebug("Payment", `Using provider=${provider.type} for ${label}`);
      const baseUrl = getBaseUrl(request);
      logDebug("Payment", `Creating checkout session baseUrl=${baseUrl}`);
      const result = await createSession(provider, baseUrl);
      if (result && "error" in result) {
        logDebug(
          "Payment",
          `Checkout validation error for ${label}: ${result.error}`,
        );
        return onError(result.error, 400);
      }
      logDebug(
        "Payment",
        `Checkout result for ${label}: ${
          result ? `url=${result.checkoutUrl}` : "null"
        }`,
      );
      return tryCheckoutRedirect(result?.checkoutUrl, () => {
        logDebug(
          "Payment",
          `Checkout redirect failed for ${label}: no session URL`,
        );
        return onError(
          "Failed to create payment session. Please try again.",
          500,
        );
      });
    },
  );
};

/** Check if all selected listings have available spots (single efficient query) */
export const checkAvailability = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  date?: string | null,
  dayCount = 1,
): Promise<boolean> =>
  checkBatchAvailability(
    buildBookings(
      listingsWithQuantity(listings, quantities),
      date ?? null,
      dayCount,
    ),
    date,
  );

/**
 * Shared booking-date fields (date + durationDays). Keeps the payment and
 * webhook flows aligned. For "customisable days" listings the booking span is
 * the visitor's chosen `dayCount`; otherwise daily listings use their fixed
 * `duration_days` and standard listings span a single day.
 */
export const bookingDateFields = (
  listing: Pick<
    TicketListing["listing"],
    "listing_type" | "duration_days" | "customisable_days"
  >,
  date: string | null,
  dayCount = 1,
): { date: string | null; durationDays: number } => ({
  date: listing.listing_type === "daily" ? date : null,
  durationDays: listing.customisable_days
    ? normalizeDurationDays(dayCount)
    : listing.listing_type === "daily"
      ? normalizeDurationDays(listing.duration_days)
      : 1,
});

/** Resolve the per-ticket price for a selected listing: customisable listings
 * are priced by the chosen day count, others by their custom/fixed unit price. */
const itemUnitPrice = (
  listing: TicketListing["listing"],
  customPrices: Map<number, number>,
  dayCount: number,
): number =>
  listing.customisable_days
    ? (dayPriceFor(listing, dayCount) ?? 0)
    : (customPrices.get(listing.id) ?? listing.unit_price);

/** Build registration items from listings and quantities */
export const buildRegistrationItems = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  customPrices: Map<number, number>,
  dayCount = 1,
): CheckoutItem[] => {
  const selected = listings.filter(({ listing }) => {
    const qty = quantities.get(listing.id);
    return qty !== undefined && qty > 0;
  });
  return selected.map(({ listing }) => ({
    listingId: listing.id,
    name: listing.name,
    quantity: quantities.get(listing.id)!,
    slug: listing.slug,
    unitPrice: itemUnitPrice(listing, customPrices, dayCount),
  }));
};

/** Handle payment flow for ticket purchase */
export const handlePaymentFlow = (
  request: Request,
  intent: CheckoutIntent,
  ctx: TicketCtx,
): Promise<Response> =>
  runCheckoutFlow(
    `ticket items=${intent.items.length}`,
    request,
    (provider, baseUrl) => provider.createCheckoutSession(intent, baseUrl),
    (msg) =>
      errorRedirect(ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`, msg),
  );

/** Handle free ticket registration */
/** Build booking objects from selected listings */
const buildBookings = (
  selected: ListingQty[],
  date: string | null,
  dayCount = 1,
): LineBooking[] =>
  selected.map(({ listing, qty }) => ({
    listingId: listing.id,
    quantity: qty,
    ...bookingDateFields(listing, date, dayCount),
  }));

/**
 * Parse and validate the visitor's chosen day count for "customisable days"
 * listings. Returns `{ dayCount }` (1 when no selected listing is customisable),
 * or `{ error }` when the choice is missing, unpriced, or — for daily listings
 * — would run the range into a holiday or past the booking window.
 */
export const resolveDayCount = async (
  selected: ListingQty[],
  form: FormParams,
  date: string | null,
): Promise<{ dayCount: number } | { error: string }> => {
  const customisable = selected.filter(
    ({ listing }) => listing.customisable_days,
  );
  if (customisable.length === 0) return { dayCount: 1 };

  const raw = parsePositiveInt(form.getString("day_count"));
  if (raw === null) {
    return { error: "Please choose how many days to book" };
  }
  for (const { listing } of customisable) {
    if (dayPriceFor(listing, raw) === null) {
      return { error: `${listing.name} does not offer a ${raw}-day booking` };
    }
  }
  const dailyCustomisable = customisable.filter(
    ({ listing }) => listing.listing_type === "daily",
  );
  if (date && dailyCustomisable.length > 0) {
    const holidays = await getActiveHolidays();
    for (const { listing } of dailyCustomisable) {
      if (!isBookingRangeValid(listing, date, raw, holidays)) {
        return {
          error: `${listing.name}: ${raw} days aren't all available from that date — choose fewer days or a different start date`,
        };
      }
    }
  }
  return { dayCount: raw };
};

type FreeReservationParams = {
  listings: TicketListing[];
  quantities: Map<number, number>;
  contact: ContactInfo;
  date: string | null;
  dayCount?: number;
  paidByListingId?: Map<number, number>;
  remainingBalance?: number;
};

type FreeReservationResult =
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string };

export const createFreeReservation = async ({
  listings,
  quantities,
  contact,
  date,
  dayCount = 1,
  paidByListingId,
  remainingBalance = 0,
}: FreeReservationParams): Promise<FreeReservationResult> => {
  const selected = listingsWithQuantity(listings, quantities);
  const bookings = buildBookings(selected, date, dayCount).map((booking) => ({
    ...booking,
    ...(paidByListingId
      ? { pricePaid: paidByListingId.get(booking.listingId)! }
      : {}),
  }));
  const result = await createAttendeeAtomic({
    ...contact,
    bookings,
    remainingBalance,
    statusId: await getPublicStatusId(),
  });

  const check = await ensureAllBookings(result, bookings.length, "public");
  if (!check.ok) {
    return {
      error: formatAtomicError(check.reason, selected[0]!.listing.name),
      success: false,
    };
  }
  // ensureAllBookings guarantees result.success after ok check
  const { attendees } = result as Extract<
    CreateAttendeeResult,
    { success: true }
  >;

  // Build entries: pair each attendee result with its listing
  const entries: EmailEntry[] = attendees.map((attendee, i) => ({
    attendee,
    listing: selected[i]!.listing,
  }));
  return {
    entries,
    success: true,
    token: attendees[0]!.ticket_token,
  };
};

/**
 * Whether any of `ids` is a child listing (invariant I3): a booking can never
 * start from a child — it is only bookable through one of its parents' per-parent
 * selectors. Every booking/checkout entry point uses this to reject (not silently
 * drop) a child it was handed directly. No-op (no query) unless the feature flag
 * is on, so existing behaviour is unchanged until parents ship.
 */
export const anyChildListing = async (
  ids: readonly number[],
): Promise<boolean> => {
  if (!isListingParentsEnabled()) return false;
  return (await getChildListingIds(ids)).size > 0;
};

/** {@link anyChildListing} for a set of rendered ticket listings — used by the
 * booking funnel to reject a child handed to it as a standalone line. */
export const containsChildListing = (
  listings: TicketListing[],
): Promise<boolean> => anyChildListing(listings.map((e) => e.listing.id));

/** Load and validate active listings, return 404 if none */
export const withActiveListings = async (
  slugs: string[],
  handler: AsyncHandler<[TicketListing[]]>,
): Promise<Response> => {
  const listings = await getListingsBySlugsBatch(slugs);
  const active = compact(listings).filter((e) => e.active);
  const activeListings = await buildTicketListingsWithGroupCapacity(active);
  return activeListings.length === 0
    ? notFoundResponse()
    : handler(activeListings);
};

/** Compute shared available dates across all daily listings (intersection) */
export const computeSharedDates = async (
  listings: TicketListing[],
): Promise<string[]> => {
  const dailyListings = listings.filter(
    (e) => e.listing.listing_type === "daily",
  );
  if (dailyListings.length === 0) return [];
  const holidays = await getActiveHolidays();
  // Customisable-days listings store duration_days as the *maximum*; their date
  // list is computed for a single day (every individually-bookable start) and
  // the chosen span is validated separately at submit time.
  const dateSets = dailyListings.map(
    (e) => new Set(getBookableStartDates(e.listing, holidays)),
  );
  return [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d)));
};

/** Fetch shared context for ticket pages: dates, terms, questions.
 * When a group is provided, its terms override global terms and its name/description are included. */
export const getTicketContext = async (
  activeListings: TicketListing[],
  group?: Group,
): Promise<TicketSharedContext> => {
  const listingIds = activeListings.map((e) => e.listing.id);
  const [dates, globalTerms, questionsResult, promoCodesEnabled, addOns] =
    await Promise.all([
      computeSharedDates(activeListings),
      Promise.resolve(settings.terms),
      getQuestionsWithListingIds(listingIds),
      hasPromoCodeModifiers(),
      getOptionalAddOns(listingIds),
    ]);
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : globalTerms;
  return {
    addOns,
    dates,
    promoCodesEnabled,
    terms,
    ...questionsResult,
    ...(group && {
      groupDescription: group.description,
      groupName: group.name,
    }),
  };
};
