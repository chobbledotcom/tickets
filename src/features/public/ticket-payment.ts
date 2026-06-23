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
import {
  bookingLedgerPoster,
  createOrSoldOut,
} from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type {
  CreateAttendeeResult,
  LineBooking,
} from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailability,
  ensureAllBookings,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getChildIds,
  getChildListingIds,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
import { getListingsBySlugsBatch } from "#shared/db/listings.ts";
import {
  getOptionalAddOns,
  hasPromoCodeModifiers,
} from "#shared/db/modifier-resolve.ts";
import type { ModifierUsage } from "#shared/db/modifier-usage.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import type { EmailEntry } from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { logDebug } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import {
  availableDayCounts,
  type ContactInfo,
  dayPriceFor,
  type Group,
  type Holiday,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import {
  type ChildSpanDates,
  childDateKey,
  childDateOk,
  childDurationMatches,
  childPricedForSpan,
  childSelectableIgnoringSpan,
  constrainOptionsByChildUnion,
  fixedParentSpan,
  resolveInheritedDuration,
  selectableChild,
  type TicketListing,
} from "#templates/public.tsx";
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
 * fixed `duration_days` for a fixed daily parent, 1 for a standard parent.
 * Specialises the shared {@link resolveInheritedDuration} with `(dayCount, 1)`. */
const parentResolvedDuration = (
  parent: TicketListing["listing"],
  dayCount: number,
): number => resolveInheritedDuration(parent, dayCount, 1);

/** Parameters for the child-bookability test: the candidate child plus the order
 * context it must be bookable against (inherited duration, resolved date, active
 * holidays). */
type ChildBookableCtx = {
  duration: number;
  date: string | null;
  holidays: Holiday[];
};

/** The date-INDEPENDENT disqualifiers `childIsBookable` applies, composed from
 * the shared atoms. The date- AND span-independent part (active, not closed,
 * standard child not date-less sold out) is {@link childSelectableIgnoringSpan}.
 * When the parent's inherited span is known (`duration` non-null) two span atoms
 * also apply: a customisable child must price the inherited duration
 * ({@link childPricedForSpan}), and a fixed daily child's `duration_days` must
 * equal it ({@link childDurationMatches}). A null `duration` (a CUSTOMISABLE
 * parent, whose span the buyer has not chosen at render) skips only those span
 * atoms — they are enforced per-span at submit. It deliberately omits the
 * child's own date calendar ({@link childDateOk}), which the union folds in
 * per-candidate-date instead (parents.md Fixes 2–4). */
const childSelectableForSpan = (
  child: TicketListing,
  duration: number | null,
): boolean =>
  selectableChild(
    compact([
      childSelectableIgnoringSpan,
      duration === null ? null : childPricedForSpan(duration),
      duration === null ? null : childDurationMatches(duration),
    ]),
  )(child);

/** A child is bookable now if it is categorically selectable for the inherited
 * span ({@link childSelectableForSpan}) and — when daily — the resolved order
 * date is within its own bookable start dates for the inherited duration
 * ({@link childDateOk}). Date-capacity for a daily child is enforced later by the
 * folded `checkAvailability` (never clamped). */
const childIsBookable = (
  child: TicketListing,
  { duration, date, holidays }: ChildBookableCtx,
): boolean =>
  childSelectableForSpan(child, duration) &&
  childDateOk(date, holidays, duration)(child);

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

/** A bookable child paired with the per-unit quantity the buyer chose for it
 * under one parent (always > 0 — zero-quantity children are dropped). */
type ChildSelection = { child: TicketListing; qty: number };

/** Parse one child's submitted per-unit quantity (`child_qty_<parentId>_<childId>`):
 * a non-negative integer, or 0 when missing/blank/invalid. The selects only emit
 * `0..min(parentQty, childMax)`, so any other value is treated as "none chosen"
 * and the sum check (below) catches a too-low total. */
const childQtyField = (
  parentId: number,
  childId: number,
  form: FormParams,
): number => {
  const raw = form.getString(`child_qty_${parentId}_${childId}`).trim();
  if (raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

/** Resolve the buyer's per-unit child selection for one in-cart parent (the
 * per-unit model): read each bookable child's `child_qty_<parentId>_<childId>`
 * into the chosen subset, auto-assign the whole parent quantity to a sole
 * bookable child when NOTHING was submitted, and require the chosen quantities to
 * sum to exactly the parent's quantity. Returns the chosen children (each with
 * qty > 0) or an error (none bookable / total too low / total too high / a
 * quantity on a non-bookable child). */
const resolveChildSelections = (
  parent: TicketListing,
  bookable: TicketListing[],
  parentQty: number,
  form: FormParams,
): ChildSelection[] | { error: string } => {
  const name = parent.listing.name;
  if (bookable.length === 0) {
    return { error: t("public.ticket.child_sold_out", { name }) };
  }
  const parentId = parent.listing.id;
  const bookableIds = new Set(bookable.map((c) => c.listing.id));
  // Reject a positive quantity submitted for a child that is not currently a
  // bookable child of this parent (an unknown id, a stranger listing, or a
  // sibling that sold out/closed between render and submit) — never silently swap
  // in a still-bookable sibling (parents.md step 3).
  const prefix = `child_qty_${parentId}_`;
  for (const key of form.keys()) {
    if (!key.startsWith(prefix)) continue;
    const childId = Number.parseInt(key.slice(prefix.length), 10);
    const qty = childQtyField(parentId, childId, form);
    if (qty > 0 && !bookableIds.has(childId)) {
      return { error: t("public.ticket.child_required", { name }) };
    }
  }
  const selections: ChildSelection[] = [];
  let total = 0;
  for (const child of bookable) {
    const qty = childQtyField(parentId, child.listing.id, form);
    if (qty > 0) {
      selections.push({ child, qty });
      total += qty;
    }
  }
  // Auto-select: nothing submitted for a sole bookable child fills the whole
  // parent quantity (the previous "one child, qty = Q" special case).
  if (total === 0 && bookable.length === 1) {
    return [{ child: bookable[0]!, qty: parentQty }];
  }
  if (total < parentQty) {
    return {
      error: t("public.ticket.child_too_few", {
        count: parentQty - total,
        name,
      }),
    };
  }
  if (total > parentQty) {
    return {
      error: t("public.ticket.child_too_many", {
        count: total - parentQty,
        name,
      }),
    };
  }
  return selections;
};

/** Read and validate a chosen child's pay-more price (when `can_pay_more`),
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

/** Fold one chosen child into the accumulator at the per-unit quantity the buyer
 * picked for it (`childQty`, not the parent quantity): sum that quantity across
 * parents/units, reconcile the customisable duration and pay-more price, and
 * re-validate the summed quantity against the child's max-purchasable cap (reject,
 * never clamp). Returns null on success or an error message. */
const foldChild = (
  state: FoldState,
  child: TicketListing,
  childQty: number,
  duration: number,
  price: number | undefined,
): string | null => {
  const childId = child.listing.id;
  const summed = (state.quantities.get(childId) ?? 0) + childQty;
  // A DAILY child's `maxPurchasable` is the date-less aggregate cap, which reads
  // 0 once the child is full on ANY single date — so it must NOT gate a booking
  // on a different date with capacity (same date-less-aggregate trap as
  // `isSoldOut`, Codex 336). Its per-date cap is enforced by the folded
  // `checkAvailability` (rejected, never clamped). A STANDARD child's cap is
  // cumulative and date-independent, so it stays authoritative here.
  if (child.listing.listing_type !== "daily" && summed > child.maxPurchasable) {
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

/** Resolve, validate and fold one in-cart parent's per-unit child selection into
 * `state`. The buyer chooses children totalling the parent's quantity in any mix
 * (per-unit model); each chosen child is folded at ITS own quantity, not the
 * parent's. Returns null on success or a user-facing error (no bookable child /
 * total below or above the parent quantity / invalid price / over-capacity /
 * mixed duration). */
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
  const selections = resolveChildSelections(parent, bookable, parentQty, form);
  if ("error" in selections) return selections.error;
  for (const { child, qty } of selections) {
    const price = childCustomPrice(parent.listing.id, child, form);
    if (price && typeof price === "object") return price.error;
    const error = foldChild(state, child, qty, duration, price);
    if (error) return error;
  }
  return null;
};

/**
 * Fold every in-cart parent's selected child into the order (steps 4–5 core,
 * parents.md "Server-side validation"). A parent is any in-cart listing with a
 * child edge in `ctx.childrenByParentId`; its children are filtered to the
 * bookable ones for the resolved date/duration, the buyer's per-unit selection
 * (children totalling the parent's quantity, auto-filled when a sole child
 * exists) is resolved, and each chosen child is folded at its own quantity into
 * the listing set + quantity/custom-price maps + selected ids — so every
 * downstream per-listing path sees the child as an ordinary line. A parent with
 * no bookable child is rejected (sold out). Child fields under a zero-quantity
 * parent are ignored, not read. No-op when no parents apply.
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
  /** Modifier stock to consume in the create transaction. Amounts are zeroed
   *  when payments are disabled — stock is still capped, nothing is charged. */
  modifierUsages: ModifierUsage[];
  /** The priced order to post to the ledger, or null to skip it (payments
   *  disabled — no money to record). Lets a zero-total free booking record the
   *  same sale/discount/balance legs a paid one would. */
  ledgerOrder: PricedOrder | null;
};

type FreeReservationResult =
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string };

/** User-facing message when a chosen add-on or discount sold out during a
 * zero-total completion (no provider in the loop, so it didn't sell out
 * "while completing payment" as the webhook path phrases it). */
export const MODIFIER_SOLD_OUT_MESSAGE =
  "An extra you selected sold out while you were checking out. Please try again.";

export const createFreeReservation = async ({
  listings,
  quantities,
  contact,
  date,
  dayCount = 1,
  paidByListingId,
  remainingBalance = 0,
  modifierUsages,
  ledgerOrder,
}: FreeReservationParams): Promise<FreeReservationResult> => {
  const selected = listingsWithQuantity(listings, quantities);
  const bookings = buildBookings(selected, date, dayCount).map((booking) => ({
    ...booking,
    ...(paidByListingId
      ? { pricePaid: paidByListingId.get(booking.listingId)! }
      : {}),
  }));
  // When there are legs to post or stock to consume, do it inside the create
  // transaction, exactly as the paid webhook does, so the booking, its stock, and
  // its sale/payment legs are all-or-nothing. The free path has no payment
  // session, so the ledger event is keyed on the new attendee id and dated now; a
  // modifier sold out mid-checkout rolls the whole create back.
  const statusId = await getPublicStatusId();
  const ledger = ledgerOrder
    ? {
        eventId: (attendeeId: number) => String(attendeeId),
        occurredAt: nowIso(),
        pricedOrder: ledgerOrder,
      }
    : null;
  // A plain provider-less booking has neither legs nor stock, so it skips the
  // interactive transaction and writes as a single batch — that keeps concurrent
  // free submissions from contending on the one connection (an empty interactive
  // transaction would still serialise them and can fail to commit mid-flight).
  const postLedger =
    ledger !== null || modifierUsages.length > 0
      ? bookingLedgerPoster(modifierUsages, ledger)
      : undefined;
  const result = await createOrSoldOut(
    { ...contact, bookings, remainingBalance, statusId },
    postLedger,
  );
  if (result === "sold-out") {
    return { error: MODIFIER_SOLD_OUT_MESSAGE, success: false };
  }

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
 * deliberately *not* applied in the shared render funnel.
 */
export const anyChildListing = async (
  ids: readonly number[],
): Promise<boolean> => (await getChildListingIds(ids)).size > 0;

/**
 * Drop child listings from an indirectly-loaded listing set (group/order pages),
 * so a child never renders as a standalone, selectable quantity row (invariant
 * I3). Unlike the explicit-slug entry points — which *reject* a child slug they
 * were handed directly (`withActiveListings`) — an indirect page loads its
 * listings from group membership / a saved cart, where a child member is
 * expected: it is folded under its parent's selector, not booked alone. The
 * parents stay in the set and re-load their children via the relationship
 * accessor (`childrenByParentId`), so this only removes the children's own
 * standalone rows (Fix 3, parents.md "strip child rows from indirect pages").
 */
export const dropChildListings = async (
  listings: readonly ListingWithCount[],
): Promise<ListingWithCount[]> => {
  const childIds = await getChildListingIds(listings.map((e) => e.id));
  return listings.filter((e) => !childIds.has(e.id));
};

/**
 * Whether `listingId` is a parent — i.e. it has at least one child edge, so a
 * booking of it requires the buyer to choose one of its children (invariant I1).
 * The web booking page enforces that choice with a per-parent selector, but the
 * JSON API has no child-selection input, so it uses this to reject a parent
 * booking and direct the caller to the web booking page (Fix 1, parents.md
 * "Public/JSON API booking").
 */
export const parentRequiresChild = async (
  listingId: number,
): Promise<boolean> => (await getChildIds(listingId)).length > 0;

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

/** A required child's contribution to its parent's bookable-date union (Codex
 * 758/449). A STANDARD (dateless) child imposes no date constraint — it is
 * bookable on EVERY parent date (subject only to its non-date capacity), so it
 * contributes all of `parentDates`. A DAILY child contributes the parent dates it
 * can actually serve for the inherited span: when the parent's span is FIXED
 * (`fixedSpan` set, e.g. a 3-day fixed daily parent) the child must cover the
 * whole span, so each candidate start is validated with the SAME
 * {@link isBookingRangeValid} the fold uses (a customisable child priced/bookable
 * only for a single Monday must NOT be offered for a Mon–Wed parent it can't
 * cover). When the parent span is NOT fixed (customisable parent, no span chosen
 * at render) it keeps the per-start {@link getBookableStartDates} behaviour. */
const childDateContribution = (
  child: TicketListing,
  parentDates: string[],
  fixedSpan: number | null,
  holidays: Holiday[],
): string[] => {
  if (child.listing.listing_type !== "daily") return parentDates;
  if (fixedSpan === null) return getBookableStartDates(child.listing, holidays);
  return parentDates.filter((d) =>
    isBookingRangeValid(child.listing, d, fixedSpan, holidays),
  );
};

/**
 * Constrain a daily parent's offered dates to those on which at least one of its
 * SELECTABLE required children is bookable (Codex 758/449/794):
 * `parentDates ∩ (UNION of the selectable children's bookable start dates)`.
 *
 * Children are first filtered by the date-INDEPENDENT disqualifiers
 * ({@link childSelectableForSpan}) so an inactive / closed / unpriced /
 * duration-incompatible child the fold would reject contributes NOTHING to the
 * union — otherwise an inactive child bookable only Tuesday would keep Tuesday
 * selectable and the submit would then fail (Codex 794). The remaining children
 * each contribute the dates they can serve for the parent's inherited span (see
 * {@link childDateContribution}). Without this, a daily parent available Mon+Tue
 * whose only ACTIVE child is bookable Mon still offers Tue and the fold rejects.
 * The caller scopes WHEN this applies (see {@link singleDailyParent}).
 */
const constrainDatesByChildUnion = (
  parentDates: string[],
  children: TicketListing[],
  fixedSpan: number | null,
  holidays: Holiday[],
): string[] =>
  constrainOptionsByChildUnion(
    parentDates,
    children,
    (c) => childSelectableForSpan(c, fixedSpan),
    (c) => childDateContribution(c, parentDates, fixedSpan, holidays),
  );

/**
 * The page's sole listing + its children when it is a daily parent, else null
 * (no date constraint applies). Scopes the child-date-union rule (Codex 758) to
 * a SINGLE-listing page that is itself a daily parent — the overwhelmingly
 * common base-unit-plus-add-on case. On a multi-listing / group page several
 * listings share one date selector, and folding one parent's child calendar into
 * the shared set could wrongly remove a date a *different* page listing needs —
 * the spec defers that to the per-selected-parent JS constraint plus the
 * authoritative submit fold, so a multi-listing page's dates are left untouched.
 */
const singleDailyParent = (
  listings: TicketListing[],
  childrenByParentId: ChildrenByParentId,
): { children: TicketListing[]; fixedSpan: number | null } | null => {
  if (listings.length !== 1) return null;
  const parent = listings[0]!;
  if (parent.listing.listing_type !== "daily") return null;
  const children = childrenByParentId.get(parent.listing.id) ?? null;
  if (!children) return null;
  return { children, fixedSpan: fixedParentSpan(parent.listing) };
};

/**
 * The parent→children relationship for the page's listings, each child
 * hydrated to a {@link TicketListing} so its availability is resolved for the
 * gate/render. No-op (empty map, no query) when the parents flag is off, so
 * existing pages are unaffected until the feature ships. Children are loaded by
 * relationship only — bookability is evaluated at render/submit against the
 * resolved date (invariant I3).
 *
 * Fix 2 (don't apply the date-less GROUP cap to a daily parent's children) needs
 * no code here: the date-less group aggregate that {@link
 * buildTicketListingsWithGroupCapacity} applies via {@link
 * getGroupRemainingByListingId} **already excludes every daily listing** (its cap
 * is per-date, so a cumulative count is meaningless — see its doc and `capacity.ts`).
 * A daily parent's group is type-homogeneous (group members must share
 * `listing_type` — `validateGroupListingType`), so any child co-grouped with a
 * daily parent is itself daily and is therefore *never* given a date-less group
 * clamp: it carries no group-remaining entry, and the fold skips a daily child's
 * date-less `maxPurchasable` outright ({@link foldChild}), deferring its per-date
 * group capacity to the date-aware {@link checkAvailability} (which rejects, never
 * clamps). A *standard* child can never share a daily parent's group (the
 * homogeneity rule blocks it at save), so the "standard child of a daily parent
 * pre-marked sold out by the date-less group aggregate" state parents.md Fix 2
 * describes is unreachable — there is no clamp to suppress. The locking tests
 * exercise the daily-parent/daily-child date-A/date-B case end-to-end.
 */
export const loadChildrenByParentId = async (
  listings: TicketListing[],
): Promise<ChildrenByParentId> => {
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

/** The selectable parent spans the child date sets are computed over (Fix 4): a
 * FIXED-duration parent has a single span ({@link fixedParentSpan} — 1 for a
 * standard parent, `duration_days` for a fixed daily parent); a CUSTOMISABLE
 * parent has one per offered day-count ({@link availableDayCounts}), since the
 * buyer picks the span and a daily child's serveable starts differ per span (a
 * 2-day span can't start where only a 1-day window fits). */
const parentRenderSpans = (parent: ListingWithCount): number[] => {
  const fixed = fixedParentSpan(parent);
  return fixed === null ? availableDayCounts(parent) : [fixed];
};

/** A DAILY child's serveable starts PER selectable parent span ({@link
 * ChildSpanDates}, Fix 4): for each span the parent can offer, the holiday-aware
 * parent dates from which the child can serve the WHOLE span — reusing the SAME
 * {@link childDateContribution} rule (with the span as its fixed span) the
 * parent's date union uses, so the client never disables a date the server would
 * accept (and never re-enables one it rejects). A fixed parent yields one entry;
 * a customisable parent yields one per day-count, so the client picks the dates
 * matching the buyer's chosen `day_count` rather than the span-agnostic one-day
 * starts (which let a 2-day child be offered a Monday it can't cover). */
const childSpanDates = (
  child: TicketListing,
  parent: ListingWithCount,
  holidays: Holiday[],
): ChildSpanDates => {
  const parentDates = getBookableStartDates(parent, holidays);
  return new Map(
    parentRenderSpans(parent).map((span) => [
      span,
      childDateContribution(child, parentDates, span, holidays),
    ]),
  );
};

/** The holiday-aware serveable start dates each DAILY child can serve per
 * selectable parent span, keyed by the (parent, child) PAIR ({@link childDateKey})
 * for the client compatibility script (Codex 430, Fix 4).
 *
 * Keying by the pair (Fix 4): the same daily child can be required by two parents
 * whose calendars/inherited spans differ, so each parent's block needs its OWN
 * `data-child-dates` for that child. Keying by child id alone let the later
 * parent overwrite the earlier parent's constraint, so a child under one parent
 * could carry the other parent's dates. A non-daily child imposes no date
 * constraint and is omitted (the client treats a missing entry as "always
 * compatible"). */
export const buildChildDatesById = (
  activeListings: TicketListing[],
  childrenByParentId: ChildrenByParentId,
  holidays: Holiday[],
): Map<string, ChildSpanDates> => {
  const result = new Map<string, ChildSpanDates>();
  for (const { listing: parent } of activeListings) {
    const children = childrenByParentId.get(parent.id);
    if (!children) continue;
    for (const child of children) {
      if (child.listing.listing_type !== "daily") continue;
      result.set(
        childDateKey(parent.id, child.listing.id),
        childSpanDates(child, parent, holidays),
      );
    }
  }
  return result;
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
  const [sharedDates, globalTerms, questionsResult, promoCodesEnabled, addOns] =
    await Promise.all([
      computeSharedDates(activeListings),
      Promise.resolve(settings.terms),
      getQuestionsWithListingIds(questionListingIds),
      hasPromoCodeModifiers(),
      getOptionalAddOns(listingIds),
    ]);
  // A daily parent's offered dates must intersect the union of its children's
  // bookable dates (Codex 758); the client compatibility script also needs each
  // daily child's serveable dates (Codex 430). Both are holiday-aware, so the
  // holidays are fetched once whenever the page has any parents; pages with no
  // parents skip the fetch entirely.
  const holidays = childrenByParentId.size > 0 ? await getActiveHolidays() : [];
  const dailyParent = singleDailyParent(activeListings, childrenByParentId);
  const dates = dailyParent
    ? constrainDatesByChildUnion(
        sharedDates,
        dailyParent.children,
        dailyParent.fixedSpan,
        holidays,
      )
    : sharedDates;
  const childDatesById = buildChildDatesById(
    activeListings,
    childrenByParentId,
    holidays,
  );
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : globalTerms;
  return {
    addOns,
    childDatesById,
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

/**
 * Constrain a daily parent's own candidate dates to those at least one of its
 * required children can actually serve for the inherited span — the SAME
 * `parentDates ∩ (union of selectable children's bookable dates)` rule the web
 * booking page applies via {@link constrainDatesByChildUnion} (invariant I6, Fix
 * 4). Used by the JSON API detail endpoint so it never advertises a date the web
 * selector removes and the fold rejects. The caller restricts this to daily
 * listings (only daily listings have an `availableDates` list).
 *
 * A `parent` with no child edges is returned unchanged: the union only applies to
 * a parent that gates a child choice. Children are loaded by relationship and
 * built to {@link TicketListing} so the same date-/span-aware availability the
 * gate uses is evaluated here.
 */
export const constrainParentDailyDates = async (
  parent: ListingWithCount,
  parentDates: string[],
  holidays: Holiday[],
): Promise<string[]> => {
  const childrenByParent = await getChildrenForParents([parent.id]);
  const childRows = childrenByParent.get(parent.id);
  if (!childRows || childRows.length === 0) return parentDates;
  const children = await buildTicketListingsWithGroupCapacity(childRows);
  return constrainDatesByChildUnion(
    parentDates,
    children,
    fixedParentSpan(parent),
    holidays,
  );
};
