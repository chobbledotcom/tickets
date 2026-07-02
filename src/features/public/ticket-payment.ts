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
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import {
  childSelectableForSpan,
  type FoldBase,
  type FoldChildrenResult,
  foldBookingTree,
  resolvedByNodeKey,
} from "#shared/booking/fold-tree.ts";
import { effectivePrice } from "#shared/booking/price-tree.ts";
import type { PriceRule } from "#shared/booking/tree.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type {
  ChildAllocation,
  CreateAttendeeResult,
  LineBooking,
} from "#shared/db/attendee-types.ts";
import { expandChildAllocations } from "#shared/db/attendees/order-parents.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  createBookingAtomic,
  ensureAllBookings,
  getGroupRemainingByGroupId,
} from "#shared/db/attendees.ts";
import {
  getGroupIdsByListingIds,
  getGroupPackagePrices,
  getHiddenPackageMemberIds,
  isHiddenPackageMember,
  packageMemberMaps,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getChildIds,
  getChildListingIds,
  getChildrenForParents,
} from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
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
  constrainOptionsByChildUnion,
  fixedParentSpan,
  type TicketListing,
} from "#templates/public.tsx";
import { formatAtomicError, listingsWithQuantity } from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type {
  AsyncHandler,
  ChildrenByParentId,
  ListingQty,
  TicketCtx,
  TicketSharedContext,
} from "./types.ts";

/** Redirect to checkout, or return the handler's error.
 * In iframe mode returns a popup page instead of a redirect: Stripe cannot run in iframes. */
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
 * In iframe mode opens checkout in a popup window instead of a redirect. */
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

/** Whether all selected listings have available spots (one batched query). */
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
 * Shared booking-date fields (date + durationDays), keeping the payment and
 * webhook flows aligned. Span: customisable listings use the chosen `dayCount`;
 * daily listings use their fixed `duration_days`; standard listings span 1 day.
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

/** Build registration items from the folded listings, pricing each line by the
 * tree's price rule via {@link effectivePrice} — a package member's `OVERRIDE`, a
 * pay-more custom price, a customisable day-price, or the base unit price, each
 * scoped correctly by construction (the override no longer needs a separate pass).
 * `priceRuleByListingId` covers every folded listing (top-level rule wins over a
 * child), so the lookup is always present. */
export const buildRegistrationItems = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  customPrices: Map<number, number>,
  priceRuleByListingId: ReadonlyMap<number, PriceRule>,
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
    unitPrice: effectivePrice(
      priceRuleByListingId.get(listing.id)!,
      listing,
      customPrices,
      dayCount,
    ),
  }));
};

/** A package group's per-member overrides for the booking flow: `prices` keeps
 * every member that has a flat override — a positive price OR an explicit free
 * (0), but not a `null` "no override"; `quantities` carries every member's
 * per-package quantity (≥1); `dayPrices` carries each customisable member's
 * per-day overrides (day count → per-unit minor price). */
export type PackageMemberMaps = {
  prices: ReadonlyMap<number, number>;
  quantities: ReadonlyMap<number, number>;
  dayPrices: ReadonlyMap<number, ReadonlyMap<number, number>>;
};

/** Load a package group's member rows once into the price + quantity + per-day
 * maps the booking flow needs (so quote and submit price/derive quantities with
 * no extra query). */
export const loadPackageMemberMaps = async (
  groupId: number,
): Promise<PackageMemberMaps> => {
  const [rows, dayPrices] = await Promise.all([
    getGroupPackagePrices(groupId),
    getGroupDayPrices(groupId),
  ]);
  return { ...packageMemberMaps(rows), dayPrices };
};

/** For a HIDDEN package, replace each checkout item's buyer-facing name with the
 * package name, so the hosted-checkout line items (Stripe/Square render
 * `CheckoutItem.name`) never reveal the member listings before the buyer pays.
 * Prices, quantities and listing ids are untouched, so the webhook still
 * revalidates each member. A no-op for a visible package or a non-package. */
export const hidePackageMemberNames = (
  items: CheckoutItem[],
  hide: boolean,
  packageName: string | undefined,
): CheckoutItem[] =>
  hide && packageName
    ? items.map((item) => ({ ...item, name: packageName }))
    : items;

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
 * Parse and validate the chosen day count for "customisable days" listings.
 * Returns `{ dayCount }` (1 when nothing selected is customisable), or `{ error }`
 * when the choice is missing, unpriced, or — for daily listings — runs the range
 * into a holiday or past the booking window.
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

/** Build the pure {@link BuildTreeInput} from a resolved ticket context, so the
 * fold walks the same canonical tree render builds. `packageGroupId` (set only for
 * a package group) selects the package root + FIXED/override member semantics; a
 * regular group carries no id on the ctx yet, so its members build as standalone
 * listing nodes (identical fold field names — the group-root identity is threaded
 * in a later sub-step, for capacity/metadata). */
export const ctxToBuildTreeInput = (ctx: TicketCtx): BuildTreeInput => ({
  childrenByParentId: ctx.childrenByParentId,
  groupId: ctx.packageGroupId ?? undefined,
  hidePackageListings: ctx.hidePackageListings,
  isPackage: ctx.packageGroupId != null,
  listings: ctx.listings,
  packageDayPrices: ctx.packageDayPrices,
  packagePrices: ctx.packagePrices,
  packageQuantities: ctx.packageQuantities,
  slugs: ctx.slugs,
});

/**
 * Fold every in-cart parent's selected children into the order (parents.md
 * "Server-side validation") by building the canonical {@link BookingTree} from the
 * resolved context and handing it to the pure {@link foldBookingTree} walk — so a
 * package member, a group member and a standalone parent all fold through one
 * recursive tree walk. Returns the expanded listing set + quantity/custom-price
 * maps + selected ids + per-(child, parent) allocations (same shape the callers
 * already consume). Holidays are fetched once, and only when a parent with
 * children is actually in the cart (a daily child validates the resolved date
 * against its own calendar).
 */
export const foldSelectedChildren = async (
  ctx: TicketCtx,
  form: FormParams,
  base: FoldBase,
): Promise<FoldChildrenResult> => {
  const tree = buildBookingTree(ctxToBuildTreeInput(ctx));
  const resolved = resolvedByNodeKey(
    ctx.listings,
    ctx.childrenByParentId,
    tree,
  );
  const hasFoldableParent = tree.nodes.some(
    (node) =>
      node.children.length > 0 &&
      (base.quantities.get(node.listingId) ?? 0) > 0,
  );
  const holidays = hasFoldableParent ? await getActiveHolidays() : [];
  return foldBookingTree(tree, resolved, form, base, holidays);
};

type FreeReservationParams = {
  listings: TicketListing[];
  quantities: Map<number, number>;
  contact: ContactInfo;
  date: string | null;
  dayCount?: number;
  paidByListingId?: Map<number, number> | undefined;
  remainingBalance?: number | undefined;
  /** Modifier stock to consume in the create transaction. Amounts are zeroed when
   *  payments are disabled — stock is still capped, nothing is charged. */
  modifierUsages: ModifierUsage[];
  /** Priced order to post to the ledger, or null to skip it (payments disabled —
   *  no money to record). Lets a zero-total free booking record the same
   *  sale/discount/balance legs a paid one would. */
  ledgerOrder: PricedOrder | null;
  /** Per-(child, parent) allocations from the fold: when present,
   * `createFreeReservation` expands each child booking into one row per
   * allocation instead of one summed row, giving each row its real
   * `parentListingId`. Absent for legacy/no-parent orders. */
  allocations?: ChildAllocation[] | undefined;
  /** When the order is a package checkout, the package group's id (stamped on
   * every booking row so the ticket view / confirmation email group the order
   * under the package). Absent / 0 for a non-package order. */
  packageGroupId?: number;
};

type FreeReservationResult =
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string };

/** User-facing message when a chosen add-on or discount sold out during a
 * zero-total completion (no provider, so the webhook path's "while completing
 * payment" wording doesn't apply). */
export const MODIFIER_SOLD_OUT_MESSAGE =
  "An extra you selected sold out while you were checking out. Please try again.";

/** A zero priced order: a free booking that consumes modifier stock but posts no
 *  legs (payments disabled) builds its batch plan from this — no lines, so
 *  mapBooking yields no legs while the modifier stock is still consumed. */
const EMPTY_PRICED_ORDER: PricedOrder = {
  extras: [],
  fullSubtotal: 0,
  lines: [],
  modifierApplications: [],
  total: 0,
};

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
  allocations,
  packageGroupId,
}: FreeReservationParams): Promise<FreeReservationResult> => {
  const selected = listingsWithQuantity(listings, quantities);
  const bookings = buildBookings(selected, date, dayCount).map((booking) => ({
    ...booking,
    ...(paidByListingId
      ? { pricePaid: paidByListingId.get(booking.listingId)! }
      : {}),
  }));
  // Expand summed child bookings into per-parent rows when allocations are
  // provided (Stage B free-path provenance): each allocation becomes its own
  // listing_attendees row with the real parentListingId, so the DB records
  // which parent each child unit came from. The slot dedup
  // (hasDuplicateBookingSlot) permits same-child/different-parent rows because
  // it keys on (listingId, date, parentListingId). The expanded list replaces
  // the summed list for the create call; ensureAllBookings' count uses the
  // expanded length.
  const finalBookings =
    allocations && allocations.length > 0
      ? expandChildAllocations(bookings, allocations)
      : bookings;
  // When there are legs to post or stock to consume, commit the booking, its
  // modifier stock, and its sale legs as ONE batch (exactly as the paid webhook
  // does) — never an interactive transaction held open across a read-per-leg. The
  // free path has no payment session, so the ledger event is keyed on a fresh
  // unique id (attendee-id-independent, so the legs are built before the attendee
  // exists) and no session is finalized; a sold-out modifier rolls the whole batch
  // back. A plain booking with neither legs nor stock has no plan, so it writes as
  // a single capacity-checked batch (createAttendeeAtomic) — concurrent free
  // submissions never contend on the one connection.
  const statusId = await getPublicStatusId();
  const input = {
    ...contact,
    bookings: finalBookings,
    // Stamp the package group id on every booking row (0 = not a package), so
    // the ticket view / confirmation email group the order under the package by
    // this persisted id rather than membership equality.
    packageGroupId: packageGroupId ?? 0,
    remainingBalance,
    statusId,
  };
  const result =
    ledgerOrder !== null || modifierUsages.length > 0
      ? await createBookingAtomic(
          input,
          await bookingBatchPlan(modifierUsages, {
            eventId: crypto.randomUUID(),
            occurredAt: nowIso(),
            pricedOrder: ledgerOrder ?? EMPTY_PRICED_ORDER,
          }),
        )
      : await createAttendeeAtomic(input);
  if (result === "sold-out") {
    return { error: MODIFIER_SOLD_OUT_MESSAGE, success: false };
  }

  const check = await ensureAllBookings(result, finalBookings.length, "public");
  if (!check.ok) {
    // A package order must never name a member in the capacity error — a hidden
    // package would leak the listing it concealed. Omit the name (generic
    // message) for a package; a non-package order keeps its single listing's name.
    const errorName = packageGroupId ? "" : selected[0]!.listing.name;
    return {
      error: formatAtomicError(check.reason, errorName),
      success: false,
    };
  }
  // ensureAllBookings's ok check guarantees result.success here.
  const { attendees } = result as Extract<
    CreateAttendeeResult,
    { success: true }
  >;

  const listingById = new Map(listings.map((l) => [l.listing.id, l.listing]));
  const entries: EmailEntry[] = attendees.map((attendee) => ({
    attendee,
    listing: listingById.get(attendee.listing_id)!,
  }));
  return {
    entries,
    success: true,
    token: attendees[0]!.ticket_token,
  };
};

/**
 * Whether any of `ids` is a child listing (invariant I3): a booking can never
 * start from a child — only through one of its parents' per-parent selectors. The
 * explicit-slug entry points (multi-slug `/ticket/<slugs>`, the signed QR, the
 * JSON API) use this to reject (not silently drop) a child handed directly.
 * Group/order pages load listings indirectly and instead suppress child rows
 * (folded under their parents), so the rejection is deliberately *not* applied in
 * the shared render funnel.
 */
export const anyChildListing = async (
  ids: readonly number[],
): Promise<boolean> => (await getChildListingIds(ids)).size > 0;

/** Whether a listing has no standalone public booking page — it is a child
 * (invariant I3) or a hidden package's member — so any admin/public affordance
 * linking to its `/ticket/<slug>` page would dead-end (404). The single test the
 * admin QR generator and the group QR route share. */
export const lacksStandalonePublicPage = async (
  listingId: number,
): Promise<boolean> =>
  (await anyChildListing([listingId])) ||
  (await isHiddenPackageMember(listingId));

/**
 * Drop child listings from an indirectly-loaded listing set (group/order pages),
 * so a child never renders as a standalone selectable quantity row (invariant I3).
 * Unlike the explicit-slug entry points — which *reject* a child slug handed
 * directly (`withActiveListings`) — an indirect page loads from group membership /
 * a saved cart, where a child member is expected: it is folded under its parent's
 * selector, not booked alone. Parents stay in the set and re-load their children
 * via `childrenByParentId`, so this only removes the children's own standalone
 * rows (Fix 3, parents.md "strip child rows from indirect pages").
 */
export const dropChildListings = async (
  listings: readonly ListingWithCount[],
): Promise<ListingWithCount[]> => {
  const childIds = await getChildListingIds(listings.map((e) => e.id));
  return listings.filter((e) => !childIds.has(e.id));
};

/**
 * Whether `listingId` is a parent (has at least one child edge), so booking it
 * requires choosing one of its children (invariant I1). The web page enforces
 * that with a per-parent selector; the JSON API has no child-selection input, so
 * it uses this to reject a parent booking and direct the caller to the web booking
 * page (Fix 1, parents.md "Public/JSON API booking").
 */
export const parentRequiresChild = async (
  listingId: number,
): Promise<boolean> => (await getChildIds(listingId)).length > 0;

/** Load active listings, 404 if none — or if any resolved slug is a child (a
 * booking can't start from a child; see {@link anyChildListing}) or a member of
 * a HIDDEN package (only the package name is public, never a member's own page;
 * the package itself is reached via its group slug, not these listing slugs). */
export const withActiveListings = async (
  slugs: string[],
  handler: AsyncHandler<[TicketListing[]]>,
): Promise<Response> => {
  const listings = await getListingsBySlugsBatch(slugs);
  const active = compact(listings).filter((e) => e.active);
  const activeListings = await buildTicketListingsWithGroupCapacity(active);
  if (activeListings.length === 0) return notFoundResponse();
  const ids = activeListings.map((e) => e.listing.id);
  if (await anyChildListing(ids)) return notFoundResponse();
  if ((await getHiddenPackageMemberIds(ids)).size > 0) {
    return notFoundResponse();
  }
  return handler(activeListings);
};

/** Shared available dates across all daily listings (intersection). */
export const computeSharedDates = async (
  listings: TicketListing[],
): Promise<string[]> => {
  const dailyListings = listings.filter(
    (e) => e.listing.listing_type === "daily",
  );
  if (dailyListings.length === 0) return [];
  const holidays = await getActiveHolidays();
  // Customisable-days listings store duration_days as the *maximum*; their date
  // list is computed for a single day (every individually-bookable start), and the
  // chosen span is validated separately at submit.
  const dateSets = dailyListings.map(
    (e) => new Set(getBookableStartDates(e.listing, holidays)),
  );
  return [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d)));
};

/** A required child's contribution to its parent's bookable-date union (Codex
 * 758/449). A STANDARD (dateless) child imposes no date constraint — bookable on
 * EVERY parent date (subject only to non-date capacity) — so it contributes all of
 * `parentDates`. A DAILY child contributes the parent dates it can serve for the
 * inherited span: when `fixedSpan` is set (e.g. a 3-day fixed daily parent) the
 * child must cover the whole span, so each candidate start is validated with the
 * SAME {@link isBookingRangeValid} the fold uses (a child bookable only for a
 * single Monday must NOT be offered for a Mon–Wed parent it can't cover). A null
 * `fixedSpan` (customisable parent, no span chosen at render) keeps the per-start
 * {@link getBookableStartDates} behaviour. */
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
 * duration-incompatible child the fold would reject contributes NOTHING — else an
 * inactive child bookable only Tuesday would keep Tuesday selectable and submit
 * would fail (Codex 794). Remaining children each contribute the dates they serve
 * for the inherited span ({@link childDateContribution}). Without this, a daily
 * parent available Mon+Tue whose only ACTIVE child is bookable Mon still offers Tue
 * and the fold rejects. The caller scopes WHEN this applies (see
 * {@link singleDailyParent}).
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
 * The page's sole listing + its children when it is a daily parent, else null.
 * Scopes the child-date-union rule (Codex 758) to a SINGLE-listing page that is
 * itself a daily parent — the common base-unit-plus-add-on case. On a multi-listing
 * / group page several listings share one date selector, and folding one parent's
 * child calendar into the shared set could wrongly remove a date a *different* page
 * listing needs — the spec defers that to the per-selected-parent JS constraint plus
 * the authoritative submit fold, so a multi-listing page's dates are left untouched.
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
 * The parent→children relationship for the page's listings, each child hydrated to
 * a {@link TicketListing} so its availability resolves for the gate/render.
 * Children are loaded by relationship only — bookability is evaluated at
 * render/submit against the resolved date (invariant I3).
 *
 * Fix 2 (don't apply the date-less GROUP cap to a daily parent's children) needs
 * no code here: the date-less group aggregate that {@link
 * buildTicketListingsWithGroupCapacity} applies via {@link
 * getGroupRemainingByListingId} **already excludes every daily listing** (its cap
 * is per-date, so a cumulative count is meaningless). A daily parent's group is
 * type-homogeneous (`validateGroupListingType`), so any child co-grouped with it is
 * itself daily and *never* gets a date-less group clamp: it carries no
 * group-remaining entry, and the fold skips a daily child's date-less
 * `maxPurchasable` outright ({@link foldChild}), deferring its per-date group
 * capacity to the date-aware {@link checkAvailability} (rejects, never clamps). A
 * *standard* child can never share a daily parent's group (homogeneity blocks it at
 * save), so the "standard child of a daily parent pre-marked sold out by the
 * date-less group aggregate" state parents.md Fix 2 describes is unreachable —
 * there is no clamp to suppress.
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
 * FIXED-duration parent has a single span ({@link fixedParentSpan}); a
 * CUSTOMISABLE parent has one per offered day-count ({@link availableDayCounts}),
 * since the buyer picks the span and a daily child's serveable starts differ per
 * span (a 2-day span can't start where only a 1-day window fits). */
const parentRenderSpans = (parent: ListingWithCount): number[] => {
  const fixed = fixedParentSpan(parent);
  return fixed === null ? availableDayCounts(parent) : [fixed];
};

/** A DAILY child's serveable starts PER selectable parent span ({@link
 * ChildSpanDates}, Fix 4): for each span the parent can offer, the holiday-aware
 * parent dates from which the child can serve the WHOLE span — reusing the SAME
 * {@link childDateContribution} rule (span as its fixed span) the parent's date
 * union uses, so the client never disables a date the server would accept (or
 * re-enables one it rejects). A fixed parent yields one entry; a customisable
 * parent one per day-count, so the client matches the buyer's chosen `day_count`
 * rather than span-agnostic one-day starts (which let a 2-day child be offered a
 * Monday it can't cover). */
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
 * `data-child-dates`. Keying by child id alone let the later parent overwrite the
 * earlier's constraint, so a child under one parent could carry the other's dates.
 * A non-daily child imposes no date constraint and is omitted (the client treats a
 * missing entry as "always compatible"). */
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

/** Shared context for ticket pages: dates, terms, questions. A group's terms
 * override global terms and its name/description are included. */
export const getTicketContext = async (
  activeListings: TicketListing[],
  group?: Group,
): Promise<TicketSharedContext> => {
  const listingIds = activeListings.map((e) => e.listing.id);
  const childrenByParentId = await loadChildrenByParentId(activeListings);
  // Child questions must be parseable/validatable at submit, so load questions for
  // the children's listing ids too (a child question activates for its child line
  // in the fold).
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
  // daily child's serveable dates (Codex 430). Both are holiday-aware, so fetch
  // holidays once when the page has any parents; pages with none skip it entirely.
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
  // For a package group, load the per-listing overrides (price + quantity) once
  // here so both the quote and submit paths can price/derive against them with
  // no extra query.
  const packageMaps =
    group?.is_package === true ? await loadPackageMemberMaps(group.id) : null;
  // Every CAPPED group the package members belong to bounds the bundle count:
  // one package consumes the sum of its members' fixed quantities from each such
  // group. Load each member's group ids and the remaining for every group any
  // member sits in (not just the package's own group), so a second capped group
  // the members happen to share also clamps the advertised package count.
  const packageMemberGroupIds =
    group?.is_package === true
      ? await getGroupIdsByListingIds(listingIds)
      : new Map<number, number[]>();
  const packageGroupRemainingByGroupId =
    group?.is_package === true
      ? await getGroupRemainingByGroupId([
          ...new Set([...packageMemberGroupIds.values()].flat()),
        ])
      : new Map<number, number>();
  return {
    addOns,
    childDatesById,
    childrenByParentId,
    dates,
    ...(group?.is_package
      ? { hidePackageListings: group.hide_package_listings }
      : {}),
    packageDayPrices: packageMaps?.dayPrices ?? null,
    packageGroupId: group?.is_package ? group.id : null,
    packageGroupRemainingByGroupId,
    packageMemberGroupIds,
    packagePrices: packageMaps?.prices ?? null,
    packageQuantities: packageMaps?.quantities ?? null,
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
 * Constrain a daily parent's candidate dates to those at least one required child
 * can serve for the inherited span — the SAME `parentDates ∩ (union of selectable
 * children's bookable dates)` rule the web booking page applies via
 * {@link constrainDatesByChildUnion} (invariant I6, Fix 4). Used by the JSON API
 * detail endpoint so it never advertises a date the web selector removes and the
 * fold rejects. The caller restricts this to daily listings (only they have an
 * `availableDates` list).
 *
 * A `parent` with no child edges is returned unchanged (the union only applies to
 * a parent that gates a child choice). Children are loaded by relationship and
 * built to {@link TicketListing} so the same date-/span-aware availability the gate
 * uses is evaluated here.
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
