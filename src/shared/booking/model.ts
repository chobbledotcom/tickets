import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type Holiday,
  type ListingWithCount,
  normalizeDurationDays,
  PARENT_CHILD_GROUP_UNITS,
  type SharedGroupCapacity,
} from "#shared/types.ts";

/** Listing info with date-less availability resolved for ticket display. */
export type TicketListing = {
  listing: ListingWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** The composite key for a parent->child date constraint. */
export const childDateKey = (parentId: number, childId: number): string =>
  `${parentId}:${childId}`;

/** A daily child's serveable start dates per selectable parent day count. */
export type ChildSpanDates = ReadonlyMap<number, string[]>;

/** Encode a child's per-span serveable dates for the `data-child-dates` attribute. */
export const encodeChildSpanDates = (bySpan: ChildSpanDates): string =>
  [...bySpan].map(([span, dates]) => `${span}:${dates.join(",")}`).join("|");

/** The child's listing row is active. */
export const childActive = (child: TicketListing): boolean =>
  child.listing.active;

/** The child is not registration-closed. */
export const childOpen = (child: TicketListing): boolean => !child.isClosed;

/** Date-less sold-out check; daily listings are judged downstream per date. */
export const childInStock = (child: TicketListing): boolean => !child.isSoldOut;

const childHasStartForSpan = (
  child: TicketListing,
  span: number,
  holidays: Holiday[],
  parentDates: ReadonlySet<string> | null,
): boolean =>
  getBookableStartDates(child.listing, holidays).some(
    (date) =>
      (parentDates === null || parentDates.has(date)) &&
      isBookingRangeValid(child.listing, date, span, holidays),
  );

/** Span-aware calendar/in-stock predicate for discovery and booking gates. */
export const childCalendarOrInStockForSpan =
  (
    holidays: Holiday[],
    span: number | null,
    parentDates: ReadonlySet<string> | null,
  ) =>
  (child: TicketListing): boolean =>
    child.listing.listing_type === "daily"
      ? childHasStartForSpan(child, span ?? 1, holidays, parentDates)
      : childInStock(child);

/** The child can be priced for the inherited span. */
export const childPricedForSpan =
  (duration: number) =>
  (child: TicketListing): boolean =>
    !child.listing.customisable_days ||
    dayPriceFor(child.listing, duration) !== null;

/** The child's booked span matches the parent's inherited duration. */
export const childDurationMatches =
  (duration: number) =>
  (child: TicketListing): boolean =>
    child.listing.customisable_days ||
    child.listing.listing_type !== "daily" ||
    normalizeDurationDays(child.listing.duration_days) === duration;

/** The order's resolved date is valid for a daily child's own calendar. */
export const childDateOk =
  (date: string | null, holidays: Holiday[], duration: number) =>
  (child: TicketListing): boolean => {
    if (child.listing.listing_type !== "daily") return true;
    if (!date) return false;
    return child.listing.customisable_days
      ? isBookingRangeValid(child.listing, date, duration, holidays)
      : getBookableStartDates(child.listing, holidays).includes(date);
  };

/** The combined one-parent-plus-one-child minimum order fits shared capacity. */
export const combinedGroupDemandFits = (cap: SharedGroupCapacity): boolean =>
  (cap.staticCap === undefined || cap.staticCap >= PARENT_CHILD_GROUP_UNITS) &&
  (cap.remaining === undefined || cap.remaining >= PARENT_CHILD_GROUP_UNITS);

/** Whole orders that fit in one capped group pool. */
export const groupPoolUnits = (remaining: number, demand: number): number =>
  Math.floor(remaining / demand);

/** Combine child-availability atoms into one AND predicate. */
export const selectableChild =
  (atoms: ((child: TicketListing) => boolean)[]) =>
  (child: TicketListing): boolean =>
    atoms.every((atom) => atom(child));

/** Date- and span-independent child disqualifiers. */
export const childSelectableIgnoringSpan: (child: TicketListing) => boolean =
  selectableChild([childActive, childOpen, childInStock]);

/** Bookable child ids for surfaces that price or cap over child nodes. */
export const bookableChildIds = (
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined,
): ReadonlySet<number> =>
  new Set(
    [...(childrenByParentId?.values() ?? [])]
      .flat()
      .filter(childSelectableIgnoringSpan)
      .map((child) => child.listing.id),
  );

/** Resolve the duration a parent's children inherit. */
export const resolveInheritedDuration = <T extends number | null>(
  parent: Pick<
    ListingWithCount,
    "customisable_days" | "duration_days" | "listing_type"
  >,
  customisableValue: T,
  standardValue: T,
): T => {
  if (parent.customisable_days) return customisableValue;
  if (parent.listing_type === "daily") {
    return normalizeDurationDays(parent.duration_days) as T;
  }
  return standardValue;
};

/** A parent's fixed inherited span, or null when the buyer chooses the span. */
export const fixedParentSpan = (
  parent: Pick<
    ListingWithCount,
    "customisable_days" | "duration_days" | "listing_type"
  >,
): number | null =>
  resolveInheritedDuration<number | null>(
    parent,
    null,
    normalizeDurationDays(parent.duration_days),
  );

/** Constrain options to those at least one selectable child supports. */
export const constrainOptionsByChildUnion = <T>(
  options: T[],
  children: readonly TicketListing[],
  selectable: (child: TicketListing) => boolean,
  contribution: (child: TicketListing) => T[],
): T[] => {
  const union = new Set<T>();
  for (const child of children.filter(selectable)) {
    for (const value of contribution(child)) union.add(value);
  }
  return options.filter((value) => union.has(value));
};

export const foldMembersWithChildren = <T>(
  members: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]>,
  initial: T,
  step: (
    current: T,
    member: TicketListing,
    children: readonly TicketListing[],
  ) => T,
): T =>
  members.reduce((current, member) => {
    const children = childrenByParentId.get(member.listing.id);
    return !children || children.length === 0
      ? current
      : step(current, member, children);
  }, initial);

/** Build a date-less availability projection for a listing. */
export const buildTicketListing = (
  listing: ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  const listingRemaining =
    listing.listing_type === "daily"
      ? Number.POSITIVE_INFINITY
      : listing.max_attendees - listing.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);
  return { isClosed: closed, isSoldOut, listing, maxPurchasable };
};

/** Shared day-count options across every customisable listing on a page. */
export const sharedDayCounts = (listings: TicketListing[]): number[] => {
  const customisable = listings.filter(
    (listing) => listing.listing.customisable_days,
  );
  if (customisable.length === 0) return [];
  const sets = customisable.map(
    (listing) => new Set(availableDayCounts(listing.listing)),
  );
  const [first, ...rest] = sets;
  return [...first!]
    .filter((n) => rest.every((set) => set.has(n)))
    .sort((a, b) => a - b);
};

/** The day-count spans a required child supports, or null for no span constraint. */
export const childSupportedSpans = (child: TicketListing): number[] | null => {
  if (child.listing.customisable_days) return availableDayCounts(child.listing);
  if (child.listing.listing_type === "daily") {
    return [normalizeDurationDays(child.listing.duration_days)];
  }
  return null;
};

/** Fold each member's selectable-child span union over `counts`. */
export const constrainCountsForMembers = (
  members: TicketListing[],
  counts: number[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
): number[] =>
  foldMembersWithChildren(
    members,
    childrenByParentId,
    counts,
    (current, _member, children) =>
      constrainOptionsByChildUnion(
        current,
        children,
        childSelectableIgnoringSpan,
        (child) => childSupportedSpans(child) ?? current,
      ),
  );

/** Constrain a customisable parent's day counts to selectable child support. */
export const constrainDayCountsByChildUnion = (
  listings: TicketListing[],
  parentDayCounts: number[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]> | undefined,
): number[] =>
  !childrenByParentId || listings.length !== 1
    ? parentDayCounts
    : constrainCountsForMembers(listings, parentDayCounts, childrenByParentId);

/** A package's day-count options constrained by every parent member's children. */
export const packageSharedDayCounts = (
  listings: TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
): number[] =>
  constrainCountsForMembers(
    listings,
    sharedDayCounts(listings),
    childrenByParentId,
  );
