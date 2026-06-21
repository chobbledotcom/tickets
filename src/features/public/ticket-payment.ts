/**
 * Payment flow, availability checks, and free registration
 */

import { compact } from "#fp";
import { t } from "#i18n";
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
import {
  getChildListingIds,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
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
  type Holiday,
  normalizeDurationDays,
} from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type { TicketListing } from "#templates/public.tsx";
import {
  formatAtomicError,
  listingsWithQuantity,
  parseCustomPrice,
} from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type {
  AsyncHandler,
  ChildrenByParentId,
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

/** The parent's resolved booking duration that its customisable children
 * inherit (invariant I4): the shared `dayCount` for a customisable parent, the
 * fixed `duration_days` for a fixed daily parent, 1 for a standard parent. */
const parentResolvedDuration = (
  parent: TicketListing["listing"],
  dayCount: number,
): number => {
  if (parent.customisable_days) return dayCount;
  if (parent.listing_type === "daily") {
    return normalizeDurationDays(parent.duration_days);
  }
  return 1;
};

/** Whether the order's resolved `date` is a valid start for a daily child's own
 * calendar at the inherited `duration` — a daily child can have different
 * bookable weekdays / windows / holidays than its parent, and `checkAvailability`
 * only checks capacity, never the child's own bookable dates (parents.md fold
 * checklist "Validate the child's own bookable DATE"). A standard (dateless)
 * child has no date constraint of its own. Uses the SAME validity the booking
 * page uses: a customisable child validates the full span with
 * {@link isBookingRangeValid}; a fixed daily child validates the start against
 * {@link getBookableStartDates}. */
const childDateIsBookable = (
  child: TicketListing,
  duration: number,
  date: string | null,
  holidays: Holiday[],
): boolean => {
  if (child.listing.listing_type !== "daily") return true;
  if (!date) return false;
  return child.listing.customisable_days
    ? isBookingRangeValid(child.listing, date, duration, holidays)
    : getBookableStartDates(child.listing, holidays).includes(date);
};

/** Parameters for the child-bookability test: the candidate child plus the order
 * context it must be bookable against (inherited duration, resolved date, active
 * holidays). */
type ChildBookableCtx = {
  duration: number;
  date: string | null;
  holidays: Holiday[];
};

/** A child is bookable now if it is active, not sold out or closed, — when
 * customisable — its inherited duration is priced, and — when daily — the
 * resolved order date is within its own bookable start dates for the inherited
 * duration. Date-capacity for a daily child is enforced later by the folded
 * `checkAvailability` (never clamped). */
const childIsBookable = (
  child: TicketListing,
  { duration, date, holidays }: ChildBookableCtx,
): boolean =>
  child.listing.active &&
  !child.isSoldOut &&
  !child.isClosed &&
  (!child.listing.customisable_days ||
    dayPriceFor(child.listing, duration) !== null) &&
  childDateIsBookable(child, duration, date, holidays);

/** The order's listing set, quantity map, custom-price map and selected ids,
 * expanded with the chosen children. Shared by the mutable fold accumulator and
 * the success result so the two never drift apart. */
type FoldedOrder = {
  listings: TicketListing[];
  quantities: Map<number, number>;
  customPrices: Map<number, number>;
  selectedListingIds: Set<number>;
};

/** Mutable accumulator threaded through the per-parent fold: the {@link
 * FoldedOrder} plus the single customisable duration seen so far (null until a
 * customisable line appears) used to reject mixed durations. */
type FoldState = FoldedOrder & {
  /** The one duration every customisable line must share, or null if none yet. */
  customisableDuration: number | null;
};

export type FoldChildrenResult =
  | (FoldedOrder & {
      ok: true;
      hasCustomisable: boolean;
      /** The single customisable duration every customisable line shares, or
       * the passed-in dayCount when no line is customisable. Drives the folded
       * order's `dayCount` so a fixed parent's customisable child is priced for
       * the inherited duration, not the default one day. */
      dayCount: number;
    })
  | { ok: false; error: string };

/** Resolve the buyer's chosen child for one in-cart parent: the submitted
 * `child_<parentId>` when it names a current bookable child, the sole bookable
 * child when none was submitted, or an error (none bookable / not chosen /
 * not a bookable child). */
const resolveChosenChild = (
  parent: TicketListing,
  bookable: TicketListing[],
  form: FormParams,
): TicketListing | { error: string } => {
  if (bookable.length === 0) {
    return {
      error: t("public.ticket.child_sold_out", { name: parent.listing.name }),
    };
  }
  const submitted = parsePositiveInt(
    form.getString(`child_${parent.listing.id}`),
  );
  if (submitted === null) {
    if (bookable.length === 1) return bookable[0]!;
    return {
      error: t("public.ticket.child_required", { name: parent.listing.name }),
    };
  }
  const chosen = bookable.find((c) => c.listing.id === submitted);
  if (!chosen) {
    return {
      error: t("public.ticket.child_required", { name: parent.listing.name }),
    };
  }
  return chosen;
};

/** Read and validate the chosen child's pay-more price (when `can_pay_more`),
 * namespaced by parent+child. Returns the price (or undefined when the child is
 * fixed-price), or an error message. */
const childCustomPrice = (
  parentId: number,
  child: TicketListing,
  form: FormParams,
): number | { error: string } | undefined => {
  if (!child.listing.can_pay_more) return undefined;
  const result = parseCustomPrice(
    form,
    `child_price_${parentId}_${child.listing.id}`,
    child.listing.unit_price,
    child.listing.max_price,
  );
  if (!result.ok) return { error: `${child.listing.name}: ${result.error}` };
  return result.price;
};

/** Record a customisable line's duration into the order's single shared
 * duration, rejecting a second distinct value (the single CheckoutIntent
 * dayCount can't represent two — parents.md "Pricing & payment round-trip").
 * Shared by the page's own customisable lines and folded customisable children.
 * Returns null on success or the mixed-duration error. */
const recordDuration = (state: FoldState, duration: number): string | null => {
  if (
    state.customisableDuration !== null &&
    state.customisableDuration !== duration
  ) {
    return t("public.ticket.mixed_durations");
  }
  state.customisableDuration = duration;
  return null;
};

/** Fold one chosen child into the accumulator: sum its quantity across parents,
 * reconcile the customisable duration and pay-more price, and re-validate the
 * summed quantity against the child's max-purchasable cap (reject, never clamp).
 * Returns null on success or an error message. */
const foldChild = (
  state: FoldState,
  child: TicketListing,
  parentQty: number,
  duration: number,
  price: number | undefined,
): string | null => {
  const childId = child.listing.id;
  const summed = (state.quantities.get(childId) ?? 0) + parentQty;
  if (summed > child.maxPurchasable) {
    return formatAtomicError("capacity_exceeded", child.listing.name);
  }
  if (child.listing.customisable_days) {
    const durationError = recordDuration(state, duration);
    if (durationError) return durationError;
  }
  if (price !== undefined) {
    const existing = state.customPrices.get(childId);
    if (existing !== undefined && existing !== price) {
      return t("public.ticket.child_price_mismatch", {
        name: child.listing.name,
      });
    }
    state.customPrices.set(childId, price);
  }
  state.quantities.set(childId, summed);
  state.selectedListingIds.add(childId);
  if (!state.listings.some((e) => e.listing.id === childId)) {
    state.listings.push(child);
  }
  return null;
};

/** Resolve, validate and fold one in-cart parent's chosen child into `state`.
 * Returns null on success or a user-facing error (no bookable child / not
 * chosen / invalid price / over-capacity / mixed duration). */
const foldParent = (
  state: FoldState,
  parent: TicketListing,
  parentQty: number,
  children: TicketListing[],
  form: FormParams,
  dayCount: number,
  date: string | null,
  holidays: Holiday[],
): string | null => {
  const duration = parentResolvedDuration(parent.listing, dayCount);
  const bookable = children.filter((c) =>
    childIsBookable(c, { date, duration, holidays }),
  );
  const chosen = resolveChosenChild(parent, bookable, form);
  if ("error" in chosen) return chosen.error;
  const price = childCustomPrice(parent.listing.id, chosen, form);
  if (price && typeof price === "object") return price.error;
  return foldChild(state, chosen, parentQty, duration, price);
};

/**
 * Fold every in-cart parent's selected child into the order (steps 4–5 core,
 * parents.md "Server-side validation"). A parent is any in-cart listing with a
 * child edge in `ctx.childrenByParentId`; its children are filtered to the
 * bookable ones for the resolved date/duration, one is chosen (auto-selected
 * when single), and folded into the listing set + quantity/custom-price maps +
 * selected ids — so every downstream per-listing path sees the child as an
 * ordinary line. A parent with no bookable child is rejected (sold out). Child
 * fields under a zero-quantity parent are ignored, not read. No-op when the
 * flag is off / no parents apply.
 */
export const foldSelectedChildren = async (
  ctx: TicketCtx,
  form: FormParams,
  base: {
    quantities: Map<number, number>;
    customPrices: Map<number, number>;
    date: string | null;
    dayCount: number;
    hasCustomisable: boolean;
  },
): Promise<FoldChildrenResult> => {
  const state: FoldState = {
    customisableDuration: null,
    customPrices: new Map(base.customPrices),
    listings: [...ctx.listings],
    quantities: new Map(base.quantities),
    selectedListingIds: new Set(base.quantities.keys()),
  };
  // The page's own customisable lines all share the one submitted `day_count`,
  // so seed the shared duration with it when any such line is in the cart; a
  // folded customisable child whose inherited duration differs is then rejected.
  if (base.hasCustomisable) state.customisableDuration = base.dayCount;

  // Daily children validate the resolved order date against their own calendar,
  // so fetch the active holidays once and share them across every parent fold.
  let holidays: Holiday[] | null = null;
  for (const parent of ctx.listings) {
    const parentQty = base.quantities.get(parent.listing.id) ?? 0;
    if (parentQty <= 0) continue;
    const children = ctx.childrenByParentId.get(parent.listing.id);
    if (!children || children.length === 0) continue;
    holidays ??= await getActiveHolidays();
    const error = foldParent(
      state,
      parent,
      parentQty,
      children,
      form,
      base.dayCount,
      base.date,
      holidays,
    );
    if (error) return { error, ok: false };
  }

  return {
    customPrices: state.customPrices,
    dayCount: state.customisableDuration ?? base.dayCount,
    hasCustomisable:
      base.hasCustomisable || state.customisableDuration !== null,
    listings: state.listings,
    ok: true,
    quantities: state.quantities,
    selectedListingIds: state.selectedListingIds,
  };
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
 * selectors. The explicit-slug entry points (multi-slug `/ticket/<slugs>`, the
 * signed QR, the JSON API) use this to reject (not silently drop) a child they
 * were handed directly. Group/order pages, which load their listings indirectly,
 * instead suppress child rows (folded under their parents) — so the rejection is
 * deliberately *not* applied in the shared render funnel. No-op (no query) unless
 * the feature flag is on, so existing behaviour is unchanged until parents ship.
 */
export const anyChildListing = async (
  ids: readonly number[],
): Promise<boolean> => {
  if (!isListingParentsEnabled()) return false;
  return (await getChildListingIds(ids)).size > 0;
};

/** Load and validate active listings, return 404 if none — or if any resolved
 * slug is a child (a booking can't start from a child; see {@link anyChildListing}). */
export const withActiveListings = async (
  slugs: string[],
  handler: AsyncHandler<[TicketListing[]]>,
): Promise<Response> => {
  const listings = await getListingsBySlugsBatch(slugs);
  const active = compact(listings).filter((e) => e.active);
  const activeListings = await buildTicketListingsWithGroupCapacity(active);
  if (activeListings.length === 0) return notFoundResponse();
  if (await anyChildListing(activeListings.map((e) => e.listing.id))) {
    return notFoundResponse();
  }
  return handler(activeListings);
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

/**
 * The parent→children relationship for the page's listings, each child
 * hydrated to a {@link TicketListing} so its availability is resolved for the
 * gate/render. No-op (empty map, no query) when the parents flag is off, so
 * existing pages are unaffected until the feature ships. Children are loaded by
 * relationship only — bookability is evaluated at render/submit against the
 * resolved date (invariant I3).
 */
export const loadChildrenByParentId = async (
  listings: TicketListing[],
): Promise<ChildrenByParentId> => {
  if (!isListingParentsEnabled()) return new Map();
  const childrenByParent = await getChildrenForParents(
    listings.map((e) => e.listing.id),
  );
  const result: ChildrenByParentId = new Map();
  for (const [parentId, children] of childrenByParent) {
    result.set(parentId, await buildTicketListingsWithGroupCapacity(children));
  }
  return result;
};

/** Distinct child listing ids across every parent's children. */
export const childListingIdsOf = (
  childrenByParentId: ChildrenByParentId,
): number[] => {
  const ids = new Set<number>();
  for (const children of childrenByParentId.values()) {
    for (const child of children) ids.add(child.listing.id);
  }
  return [...ids];
};

/** Fetch shared context for ticket pages: dates, terms, questions.
 * When a group is provided, its terms override global terms and its name/description are included. */
export const getTicketContext = async (
  activeListings: TicketListing[],
  group?: Group,
): Promise<TicketSharedContext> => {
  const listingIds = activeListings.map((e) => e.listing.id);
  const childrenByParentId = await loadChildrenByParentId(activeListings);
  // Child questions must be parseable/validatable at submit, so load questions
  // for the children's listing ids too (keyed by question id, so a child
  // question activates for its child line in the fold).
  const questionListingIds = [
    ...listingIds,
    ...childListingIdsOf(childrenByParentId),
  ];
  const [dates, globalTerms, questionsResult, promoCodesEnabled, addOns] =
    await Promise.all([
      computeSharedDates(activeListings),
      Promise.resolve(settings.terms),
      getQuestionsWithListingIds(questionListingIds),
      hasPromoCodeModifiers(),
      getOptionalAddOns(listingIds),
    ]);
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : globalTerms;
  return {
    addOns,
    childrenByParentId,
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
