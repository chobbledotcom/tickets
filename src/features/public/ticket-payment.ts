/**
 * Payment flow, availability checks, and free registration
 */

import { intersect } from "@std/collections";
import { compact, requiredMapValue, unique } from "#fp";
import { checkoutResponse } from "#routes/payment-response.ts";
import { errorRedirect, notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import type { CartDateItem } from "#shared/booking/cart-conflicts.ts";
import {
  childSelectableForSpan,
  type FoldBase,
  type FoldChildrenResult,
  foldBookingTree,
  resolvedByNodeKey,
} from "#shared/booking/fold-tree.ts";
import { formatAtomicError } from "#shared/booking/form.ts";
import {
  type ChildDatesByDayCount,
  childDateKey,
  fixedParentDays,
  keepOptionsSomeChildSupports,
  type TicketListing,
  updateForMembersWithChildren,
} from "#shared/booking/model.ts";
import {
  buildPagePackage,
  combinedPackageTerms,
  explicitStandaloneIds,
  type PagePackage,
} from "#shared/booking/page-packages.ts";
import type { BookingTree } from "#shared/booking/tree.ts";
/* jscpd:ignore-start */
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
/* jscpd:ignore-end */
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import type {
  ChildAllocation,
  LineBooking,
} from "#shared/db/attendee-types.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getDatelessGroupRemaining } from "#shared/db/attendees/capacity/groups.ts";
import {
  getHiddenPackageMemberIds,
  isHiddenPackageMember,
  listingGroups,
  loadPackageMemberPricingByGroupIds,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getImageFilenamesForItem } from "#shared/db/images.ts";
import {
  anyNonStandaloneChild,
  hydrateListingLinks,
  listingChildren,
  listingParents,
} from "#shared/db/listing-parents.ts";
import { getListingsBySlugs } from "#shared/db/listings/records.ts";
import {
  getOptionalAddOns,
  hasPromoCodeModifiers,
} from "#shared/db/modifier-resolve.ts";
import type { ModifierUsage } from "#shared/db/modifier-usage.ts";
import { getQuestionsWithListingIds } from "#shared/db/questions/queries.ts";
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
import { requireValue } from "#shared/required-value.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import {
  availableDayCounts,
  type ContactInfo,
  dayPriceFor,
  type Group,
  type Holiday,
  type ListingWithCount,
} from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
/* jscpd:ignore-start */
import { listingsWithQuantity } from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import { ticketPageUrl } from "./ticket-page-url.ts";
import type {
  ChildrenByParentId,
  ListingQty,
  TicketCtx,
  TicketSharedContext,
} from "./types.ts";
/* jscpd:ignore-end */

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
  intent: CheckoutIntent,
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
      const result = await provider.createCheckoutSession(intent, baseUrl);
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
  attendeesApi.checkBatchAvailability(
    buildBookings(
      listingsWithQuantity(listings, quantities),
      date ?? null,
      dayCount,
    ),
    date,
  );

/** One package on a booking page: the group, and the members that survived the
 * page's own drops. */
export type PagePackageEntry = {
  group: Group;
  memberListingIds: readonly number[];
};

/** Load every listed package's pricing in one batch and shape each into the
 * {@link PagePackage} the booking flow carries — the group's display fields
 * plus its member quantity/price maps, scoped to the members actually on the
 * page. A cart naming many packages costs the same two reads as one. */
export const loadPagePackages = async (
  entries: readonly PagePackageEntry[],
): Promise<PagePackage[]> => {
  const pricingByGroup = await loadPackageMemberPricingByGroupIds(
    entries.map((entry) => entry.group.id),
  );
  return entries.map((entry) =>
    buildPagePackage(
      entry.group,
      entry.memberListingIds,
      requiredMapValue(
        pricingByGroup,
        entry.group.id,
        "Missing package pricing",
      ),
    ),
  );
};

/** One group's page package, through the shared many-package path. */
export const loadPagePackage = async (
  group: Group,
  memberListingIds: readonly number[],
): Promise<PagePackage> =>
  requireValue(
    (await loadPagePackages([{ group, memberListingIds }]))[0],
    `Missing page package for group ${group.id}`,
  );

export const handlePaymentFlow = (
  request: Request,
  intent: CheckoutIntent,
  ctx: TicketCtx,
): Promise<Response> =>
  runCheckoutFlow(
    `ticket items=${intent.items.length}`,
    request,
    intent,
    (msg) => errorRedirect(ticketPageUrl(ctx), msg),
  );

const buildBookings = (
  selected: ListingQty[],
  date: string | null,
  dayCount: number,
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
 * into a holiday or past the booking window. `standIns` maps each concealed
 * listing to its HIDDEN package's name, which replaces that listing's name in
 * errors so a concealed member is never named in the flash the buyer is bounced
 * back with.
 */
export const resolveDayCount = async (
  selected: ListingQty[],
  form: FormParams,
  date: string | null,
  standIns?: ReadonlyMap<number, string>,
): Promise<{ dayCount: number } | { error: string }> => {
  const shownName = (listing: ListingWithCount): string =>
    standIns?.get(listing.id) ?? listing.name;
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
      return {
        error: `${shownName(listing)} does not offer a ${raw}-day booking`,
      };
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
          error: `${shownName(
            listing,
          )}: ${raw} days aren't all available from that date — choose fewer days or a different start date`,
        };
      }
    }
  }
  return { dayCount: raw };
};

/** Build the pure {@link BuildTreeInput} from a resolved ticket context, so the
 * fold walks the same canonical tree render builds. Each page package's members
 * build as that package's FIXED/override member nodes — plus a standalone node
 * when the cart also added the member by its own slug — and every other listing
 * as a standalone node (a regular group carries no id on the ctx yet, so its
 * members build as standalone listing nodes — identical fold field names). */
export const ctxToBuildTreeInput = (ctx: TicketCtx): BuildTreeInput => ({
  childrenByParentId: ctx.childrenByParentId,
  listings: ctx.listings,
  packages: ctx.packages,
  slugs: ctx.slugs,
  standaloneListingIds: explicitStandaloneIds(
    ctx.listings.map((info) => info.listing),
    ctx.packages,
    ctx.slugs,
  ),
});

/**
 * Fold every in-cart parent's selected children into the order by building the
 * canonical {@link BookingTree} from the
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
  prebuiltTree?: BookingTree,
): Promise<FoldChildrenResult> => {
  // A caller that already built the ctx's tree (the API book path builds it
  // for the cap) passes it in rather than walking the graph twice per request.
  const tree = prebuiltTree ?? buildBookingTree(ctxToBuildTreeInput(ctx));
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
  /** The order's per-path checkout lines ({@link buildOrderLines}) — each
   * becomes its own booking row carrying its package and its charged amount. */
  items: CheckoutItem[];
  listings: TicketListing[];
  contact: ContactInfo;
  date: string | null;
  dayCount?: number;
  paidByItem?: Map<CheckoutItem, number> | undefined;
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
};

type FreeReservationResult =
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string };

/** User-facing message when a chosen add-on or discount sold out during a
 * zero-total completion (no provider, so the webhook path's "while completing
 * payment" wording doesn't apply). */
const MODIFIER_SOLD_OUT_MESSAGE =
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
  items,
  listings,
  contact,
  date,
  dayCount = 1,
  paidByItem,
  remainingBalance = 0,
  modifierUsages,
  ledgerOrder,
  allocations,
}: FreeReservationParams): Promise<FreeReservationResult> => {
  const listingById = new Map(
    listings.map((info) => [info.listing.id, info.listing]),
  );
  const finalBookings = bookingsForOrder(
    { allocations, date, dayCount },
    checkoutBookingLines(items, listingById, paidByItem),
  );
  // When there are legs to post or stock to consume, commit the booking, its
  // modifier stock, and its sale legs as ONE batch (exactly as the paid webhook
  // does) — never an interactive transaction held open across a read-per-leg. The
  // free path has no payment session, so the ledger event is keyed on a fresh
  // unique id (attendee-id-independent, so the legs are built before the attendee
  // exists) and no session is finalized; a sold-out modifier rolls the whole batch
  // back. A plain booking with neither legs nor stock has no plan, so it writes as
  // a single capacity-checked batch (createAttendeeAtomic) — concurrent free
  // submissions never contend on the one connection.
  const statusId = await requirePublicStatusId();
  const input = {
    ...contact,
    bookings: finalBookings,
    remainingBalance,
    statusId,
  };
  const result =
    ledgerOrder !== null || modifierUsages.length > 0
      ? await attendeesApi.createBookingAtomic(
          input,
          await bookingBatchPlan(modifierUsages, {
            eventId: crypto.randomUUID(),
            occurredAt: nowIso(),
            pricedOrder: ledgerOrder ?? EMPTY_PRICED_ORDER,
          }),
        )
      : await attendeesApi.createAttendeeAtomic(input);
  if (result === "sold-out") {
    return { error: MODIFIER_SOLD_OUT_MESSAGE, success: false };
  }

  if (!result.success) {
    // A package order must never name a member in the capacity error — a hidden
    // package would leak the listing it concealed. Omit the name (generic
    // message) for a package; a non-package order keeps its first listing's name.
    const errorName = items.some((item) => item.packageGroupId !== undefined)
      ? ""
      : listingById.get(items[0]!.listingId)!.name;
    return {
      error: formatAtomicError(result.reason, errorName),
      success: false,
    };
  }
  const { attendees } = result;

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

/** Whether a listing has no standalone public booking page — it is a
 * non-standalone child (a child NOT flagged `bookable_alone`) or a
 * hidden package's member — so any admin/public affordance linking to its
 * `/ticket/<slug>` page would dead-end (404). A `bookable_alone` child keeps its
 * own page, so it is NOT flagged here. The single test the admin QR generator and
 * the group QR route share. */
export const lacksStandalonePublicPage = async (
  listingId: number,
): Promise<boolean> =>
  (await anyNonStandaloneChild([listingId])) ||
  (await isHiddenPackageMember(listingId));

/**
 * Drop child listings from an indirectly-loaded listing set (group/order pages),
 * so a child never renders as a standalone selectable quantity row.
 * Unlike the explicit-slug entry points — which *reject* a child slug handed
 * directly (`withActiveListings`) — an indirect page loads from group membership /
 * a saved cart, where a child member is expected: it is folded under its parent's
 * selector, not booked alone. Parents stay in the set and re-load their children
 * via `childrenByParentId`, so this only removes the children's own standalone
 * rows.
 */
export const dropChildListings = async (
  listings: readonly ListingWithCount[],
): Promise<ListingWithCount[]> => {
  const parentsByChild = await listingParents.getIdsByKeys(
    listings.map((listing) => listing.id),
  );
  return listings.filter(
    (listing) => parentsByChild.get(listing.id)!.length === 0,
  );
};

/**
 * Whether `listingId` is a parent (has at least one child edge), so booking it
 * requires choosing one of its children. The web page enforces
 * that with a per-parent selector; the JSON API has no child-selection input, so
 * it uses this to reject a parent booking and direct the caller to the web booking
 * page.
 */
export const parentRequiresChild = async (
  listingId: number,
): Promise<boolean> => (await listingChildren.getIds(listingId)).length > 0;

/** Load active listings, 404 if none — or if any resolved slug is a
 * non-standalone child (a booking can't start from a child unless it is flagged
 * `bookable_alone`; see {@link anyNonStandaloneChild}) or a member of a HIDDEN
 * package (only the package name is public, never a member's own page; the
 * package itself is reached via its group slug, not these listing slugs). */
export const withActiveListings = async (
  slugs: string[],
  handler: ResponseHandler<[listings: TicketListing[]]>,
): Promise<Response> => {
  const listings = await getListingsBySlugs(slugs);
  const active = compact(listings).filter((e) => e.active);
  const activeListings = await buildTicketListingsWithGroupCapacity(active);
  if (activeListings.length === 0) return notFoundResponse();
  const ids = activeListings.map((e) => e.listing.id);
  if (await anyNonStandaloneChild(ids)) return notFoundResponse();
  if ((await getHiddenPackageMemberIds(ids)).size > 0) {
    return notFoundResponse();
  }
  return handler(activeListings);
};

/** Each daily listing on the page with its own bookable start dates — the
 * date facts the cart conflict rules read, and what the page's shared date
 * list intersects. Customisable-days listings store duration_days as the
 * *maximum*; their date list is computed for a single day (every
 * individually-bookable start), and the chosen span is validated separately
 * at submit. */
export const dailyDateItems = async (
  listings: TicketListing[],
): Promise<CartDateItem[]> => {
  const dailyListings = listings.filter(
    (e) => e.listing.listing_type === "daily",
  );
  if (dailyListings.length === 0) return [];
  const holidays = await getActiveHolidays();
  return dailyListings.map((e) => ({
    dates: getBookableStartDates(e.listing, holidays),
    id: e.listing.id,
    name: e.listing.name,
  }));
};

/** A daily listing's span rules: the fixed day count to book (null = the buyer
 * picks) and the holidays that block start dates. */
type DailySpan = { fixedDays: number | null; holidays: Holiday[] };

/** Dates this child can serve for the parent. */
const datesChildCanServe = (
  child: TicketListing,
  parentDates: string[],
  { fixedDays, holidays }: DailySpan,
): string[] => {
  if (child.listing.listing_type !== "daily") return parentDates;
  if (fixedDays === null) return getBookableStartDates(child.listing, holidays);
  return parentDates.filter((d) =>
    isBookingRangeValid(child.listing, d, fixedDays, holidays),
  );
};

/** Keeps parent dates where at least one required child can also be booked. */
const keepDatesSomeChildCanServe = (
  parentDates: string[],
  children: readonly TicketListing[],
  span: DailySpan,
): string[] =>
  keepOptionsSomeChildSupports(
    parentDates,
    children,
    (c) => childSelectableForSpan(c, span.fixedDays),
    (c) => datesChildCanServe(c, parentDates, span),
  );

/** The single daily parent on the page, with its children, if there is one. */
const singleDailyParent = (
  listings: TicketListing[],
  childrenByParentId: ChildrenByParentId,
): { children: TicketListing[]; fixedDays: number | null } | null => {
  if (listings.length !== 1) return null;
  const parent = listings[0]!;
  if (parent.listing.listing_type !== "daily") return null;
  const children = childrenByParentId.get(parent.listing.id) ?? null;
  if (!children) return null;
  return { children, fixedDays: fixedParentDays(parent.listing) };
};

/** Keeps package dates where every daily parent member's children can be booked. */
const keepPackageDatesChildrenCanServe = (
  members: TicketListing[],
  childrenByParentId: ChildrenByParentId,
  dates: string[],
  holidays: Holiday[],
): string[] =>
  updateForMembersWithChildren(
    members,
    childrenByParentId,
    dates,
    (acc, member, children) =>
      member.listing.listing_type !== "daily"
        ? acc
        : keepDatesSomeChildCanServe(acc, children, {
            fixedDays: fixedParentDays(member.listing),
            holidays,
          }),
  );

/**
 * The parent→children relationship for the page's listings, each child hydrated to
 * a {@link TicketListing} so its availability resolves for the gate/render.
 * Children are loaded by relationship only — bookability is evaluated at
 * render/submit against the resolved date.
 *
 * Not applying the date-less GROUP cap to a daily parent's children needs
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
 * date-less group aggregate" state is unreachable —
 * there is no clamp to suppress.
 */
export const loadChildrenByParentId = async (
  listings: TicketListing[],
): Promise<ChildrenByParentId> => {
  const childLinks = await hydrateListingLinks(
    listingChildren,
    listings.map((e) => e.listing.id),
  );
  const childrenByParent = childLinks.listingsByKey;
  const result: ChildrenByParentId = new Map();
  for (const [parentId, children] of childrenByParent) {
    result.set(parentId, await buildTicketListingsWithGroupCapacity(children));
  }
  return result;
};

/** Every parent's children flattened to their listings, in parent order. */
export const allChildListings = (
  childrenByParentId: ChildrenByParentId,
): ListingWithCount[] =>
  [...childrenByParentId.values()].flat().map((child) => child.listing);

/** Distinct child listing ids across every parent's children. */
export const childListingIdsOf = (
  childrenByParentId: ChildrenByParentId,
): number[] =>
  unique(allChildListings(childrenByParentId).map((listing) => listing.id));

/** Day counts the parent can pass to daily children. */
const parentDayCountsForChildren = (parent: ListingWithCount): number[] => {
  const fixed = fixedParentDays(parent);
  return fixed === null ? availableDayCounts(parent) : [fixed];
};

/** Child start dates for each parent day count. */
const childDatesForParentDayCounts = (
  child: TicketListing,
  parent: ListingWithCount,
  holidays: Holiday[],
): ChildDatesByDayCount => {
  const parentDates = getBookableStartDates(parent, holidays);
  return new Map(
    parentDayCountsForChildren(parent).map((days) => [
      days,
      datesChildCanServe(child, parentDates, { fixedDays: days, holidays }),
    ]),
  );
};

/** Daily-child start dates, keyed by parent and child together. */
export const buildChildDatesById = (
  activeListings: TicketListing[],
  childrenByParentId: ChildrenByParentId,
  holidays: Holiday[],
): Map<string, ChildDatesByDayCount> => {
  const result = new Map<string, ChildDatesByDayCount>();
  for (const { listing: parent } of activeListings) {
    const children = childrenByParentId.get(parent.id);
    if (!children) continue;
    for (const child of children) {
      if (child.listing.listing_type !== "daily") continue;
      result.set(
        childDateKey(parent.id, child.listing.id),
        childDatesForParentDayCounts(child, parent, holidays),
      );
    }
  }
  return result;
};

/** Shared context for ticket pages: dates, terms, questions. A group's terms
 * override global terms and its name/description are included. */
/** Group info needed to check a package's whole-package limit. */
export const loadPackageLimitGroupMaps = async (
  members: TicketListing[],
  childrenByParentId: ChildrenByParentId,
): Promise<{
  groupIdsByListingId: Map<number, number[]>;
  groupRemainingByGroupId: ReadonlyMap<number, number>;
}> => {
  const limitListings = [
    ...members.map((e) => e.listing),
    ...[...childrenByParentId.values()].flat().map((e) => e.listing),
  ];
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    limitListings.map((l) => l.id),
  );
  return {
    groupIdsByListingId,
    groupRemainingByGroupId: await getDatelessGroupRemaining(
      limitListings,
      groupIdsByListingId,
    ),
  };
};

/** The page header whose gallery is shown: a group takes priority, otherwise a
 * sole listing supplies the header. A multi-listing page has no one gallery. */
export const ticketGalleryTarget = (
  activeListings: readonly TicketListing[],
  group?: Group,
): TicketSharedContext["galleryTarget"] => {
  if (group) return { id: group.id, type: "group" };
  if (activeListings.length === 1) {
    return { id: activeListings[0]!.listing.id, type: "listing" };
  }
  return null;
};

export const getTicketContext = async (
  activeListings: TicketListing[],
  group?: Group,
  pagePackages?: PagePackage[],
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
  const [
    cartDateItems,
    globalTerms,
    questionsResult,
    promoCodesEnabled,
    addOns,
    groupImage,
  ] = await Promise.all([
    dailyDateItems(activeListings),
    Promise.resolve(settings.terms),
    getQuestionsWithListingIds(questionListingIds),
    hasPromoCodeModifiers(),
    getOptionalAddOns(listingIds),
    group ? getImageFilenamesForItem("group", group.id) : undefined,
  ]);
  // The header entity whose image gallery the page renders: the group on a
  // group page, or the sole listing on a single-listing page (a multi-listing
  // combo has no single header). Just the reference here — the images are read
  // lazily on the render path only (renderCtx), so submit/quote/API pay nothing.
  const galleryTarget = ticketGalleryTarget(activeListings, group);
  // A daily parent's offered dates must intersect the union of its children's
  // bookable dates; the client compatibility script also needs each
  // daily child's serveable dates. Both are holiday-aware, so fetch
  // holidays once when the page has any parents; pages with none skip it entirely.
  const holidays = childrenByParentId.size > 0 ? await getActiveHolidays() : [];
  // The page's bundles: a mixed cart passes its already-loaded packages in; a
  // single-group package page builds its one PagePackage from the group ("a
  // single item is an array of one"). Loaded once here so quote and submit
  // price/derive against the same maps with no extra query.
  const packages =
    pagePackages ??
    (group?.is_package === true
      ? [await loadPagePackage(group, listingIds)]
      : []);
  // The dates the page can offer start from what EVERY daily listing supports.
  const sharedDates = intersect(...cartDateItems.map((item) => item.dates));
  const dailyParent = singleDailyParent(activeListings, childrenByParentId);
  const dates = dailyParent
    ? keepDatesSomeChildCanServe(sharedDates, dailyParent.children, {
        fixedDays: dailyParent.fixedDays,
        holidays,
      })
    : packages.length > 0
      ? keepPackageDatesChildrenCanServe(
          activeListings,
          childrenByParentId,
          sharedDates,
          holidays,
        )
      : sharedDates;
  const childDatesById = buildChildDatesById(
    activeListings,
    childrenByParentId,
    holidays,
  );
  // A group page's own terms win; a cart shows every selected package's terms.
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : combinedPackageTerms(packages, globalTerms || "");
  const packageCapMaps =
    packages.length > 0
      ? await loadPackageLimitGroupMaps(activeListings, childrenByParentId)
      : {
          groupIdsByListingId: new Map<number, number[]>(),
          groupRemainingByGroupId: new Map<number, number>(),
        };
  return {
    addOns,
    cartDateItems,
    childDatesById,
    childrenByParentId,
    dates,
    galleryImages: [],
    galleryTarget,
    packageGroupRemainingByGroupId: packageCapMaps.groupRemainingByGroupId,
    packageMemberGroupIds: packageCapMaps.groupIdsByListingId,
    packages,
    promoCodesEnabled,
    terms,
    ...questionsResult,
    ...(group && {
      groupDescription: group.description,
      groupImage: groupImage!,
      groupName: group.name,
    }),
  };
};

/** Keeps daily parent dates where at least one required child can be booked. */
export const keepParentDailyDatesChildrenCanServe = async (
  parent: ListingWithCount,
  parentDates: string[],
  holidays: Holiday[],
): Promise<string[]> => {
  const { listingsByKey: childrenByParent } = await hydrateListingLinks(
    listingChildren,
    [parent.id],
  );
  const childRows = childrenByParent.get(parent.id);
  if (!childRows || childRows.length === 0) return parentDates;
  const children = await buildTicketListingsWithGroupCapacity(childRows);
  return keepDatesSomeChildCanServe(parentDates, children, {
    fixedDays: fixedParentDays(parent),
    holidays,
  });
};
