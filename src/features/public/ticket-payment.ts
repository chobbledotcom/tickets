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
import { isPaymentsEnabled } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  ensureAllBookings,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListingsBySlugsBatch } from "#shared/db/listings.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import type { EmailEntry } from "#shared/email.ts";
import { logDebug } from "#shared/logger.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import {
  type ContactInfo,
  type Group,
  normalizeDurationDays,
} from "#shared/types.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
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
): Promise<boolean> =>
  checkBatchAvailability(
    buildBookings(listingsWithQuantity(listings, quantities), date ?? null),
    date,
  );

/**
 * Shared booking-date fields (date + durationDays). Keeps the payment and
 * webhook flows aligned: both read duration from the listing at insert time.
 */
export const bookingDateFields = (
  listing: Pick<TicketListing["listing"], "listing_type" | "duration_days">,
  date: string | null,
): { date: string | null; durationDays: number } => ({
  date: listing.listing_type === "daily" ? date : null,
  durationDays:
    listing.listing_type === "daily"
      ? normalizeDurationDays(listing.duration_days)
      : 1,
});

/** Build registration items from listings and quantities */
export const buildRegistrationItems = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  customPrices: Map<number, number>,
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
    unitPrice: customPrices.get(listing.id) ?? listing.unit_price,
  }));
};

/** Check if any selected listing requires payment */
export const anyRequiresPayment = (items: CheckoutItem[]): boolean => {
  const paymentsEnabled = isPaymentsEnabled();
  if (!paymentsEnabled) return false;
  return items.some((item) => item.unitPrice > 0);
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
): {
  listingId: number;
  quantity: number;
  date: string | null;
  durationDays: number;
}[] =>
  selected.map(({ listing, qty }) => ({
    listingId: listing.id,
    quantity: qty,
    ...bookingDateFields(listing, date),
  }));

export const processFreeReservation = async (
  listings: TicketListing[],
  quantities: Map<number, number>,
  contact: ContactInfo,
  date: string | null,
  siteToken?: string,
): Promise<
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string }
> => {
  const selected = listingsWithQuantity(listings, quantities);
  const bookings = buildBookings(selected, date);
  const result = await createAttendeeAtomic({
    ...contact,
    bookings,
    statusId: await getPublicStatusId(),
  });

  const check = await ensureAllBookings(result, bookings.length);
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

  // Hash before passing on so the renewal lookup uses the same blind index
  // the paid path would carry through Stripe session metadata.
  const siteTokenIndex = siteToken ? await hmacHash(siteToken) : undefined;
  await logAndNotifyRegistration(entries, siteTokenIndex);
  return {
    entries,
    success: true,
    token: attendees[0]!.ticket_token,
  };
};

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
  const dateSets = dailyListings.map(
    (e) => new Set(getAvailableDates(e.listing, holidays)),
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
  const [dates, globalTerms, questionsResult] = await Promise.all([
    computeSharedDates(activeListings),
    Promise.resolve(settings.terms),
    getQuestionsWithListingIds(listingIds),
  ]);
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : globalTerms;
  return {
    dates,
    terms,
    ...questionsResult,
    ...(group && {
      groupDescription: group.description,
      groupName: group.name,
    }),
  };
};
