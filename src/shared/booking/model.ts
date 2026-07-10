import { hasCapacityRule } from "#shared/capacity-rules.ts";
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

/** Listing info with availability ready for ticket display. */
export type TicketListing = {
  listing: ListingWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** The key for one parent and one child. */
export const childDateKey = (parentId: number, childId: number): string =>
  `${parentId}:${childId}`;

/** Start dates a daily child can offer for each parent day count. */
export type ChildDatesByDayCount = ReadonlyMap<number, string[]>;

/** Packs child dates for the HTML `data-child-dates` attribute. */
export const encodeChildDatesByDayCount = (
  byDayCount: ChildDatesByDayCount,
): string =>
  [...byDayCount]
    .map(([days, dates]) => `${days}:${dates.join(",")}`)
    .join("|");

/** The child's listing row is active. */
export const childActive = (child: TicketListing): boolean =>
  child.listing.active;

/** The child is not registration-closed. */
export const childOpen = (child: TicketListing): boolean => !child.isClosed;

/** Sold-out check before a date is chosen; daily listings are checked later. */
export const childInStock = (child: TicketListing): boolean => !child.isSoldOut;

const childHasStartForDays = (
  child: TicketListing,
  days: number,
  holidays: Holiday[],
  parentDates: ReadonlySet<string> | null,
): boolean =>
  getBookableStartDates(child.listing, holidays).some(
    (date) =>
      (parentDates === null || parentDates.has(date)) &&
      isBookingRangeValid(child.listing, date, days, holidays),
  );

/** Checks a child has either a valid date or ordinary stock. */
export const childHasDateOrStockForDays =
  (
    holidays: Holiday[],
    days: number | null,
    parentDates: ReadonlySet<string> | null,
  ) =>
  (child: TicketListing): boolean =>
    child.listing.listing_type === "daily"
      ? childHasStartForDays(child, days ?? 1, holidays, parentDates)
      : childInStock(child);

/** Checks the child has a price for the chosen day count. */
export const childHasPriceForDays =
  (days: number) =>
  (child: TicketListing): boolean =>
    !child.listing.customisable_days ||
    dayPriceFor(child.listing, days) !== null;

/** Checks a fixed daily child lasts the same number of days as the parent. */
export const childUsesSameDays =
  (days: number) =>
  (child: TicketListing): boolean =>
    child.listing.customisable_days ||
    child.listing.listing_type !== "daily" ||
    normalizeDurationDays(child.listing.duration_days) === days;

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

/** Checks one parent plus one child can fit in their shared group. */
export const parentAndChildFitGroup = (
  capacity: SharedGroupCapacity,
): boolean =>
  (capacity.staticCap === undefined ||
    capacity.staticCap >= PARENT_CHILD_GROUP_UNITS) &&
  (capacity.remaining === undefined ||
    capacity.remaining >= PARENT_CHILD_GROUP_UNITS);

/** Whole tickets that fit in a shared pool of remaining spots. */
export const ticketsThatFitInPool = (
  remaining: number,
  spotsNeeded: number,
): number => Math.floor(remaining / spotsNeeded);

/** Builds one child check from smaller child checks. */
export const childPassesAllChecks =
  (checks: ((child: TicketListing) => boolean)[]) =>
  (child: TicketListing): boolean =>
    checks.every((check) => check(child));

/** Checks if a child can be picked before the buyer chooses days. */
export const childCanBePickedBeforeDays: (child: TicketListing) => boolean =
  childPassesAllChecks([childActive, childOpen, childInStock]);

/** Child ids that can still be booked. */
export const bookableChildIds = (
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined,
): ReadonlySet<number> =>
  new Set(
    [...(childrenByParentId?.values() ?? [])]
      .flat()
      .filter(childCanBePickedBeforeDays)
      .map((child) => child.listing.id),
  );

/** Gets the day count a child should use from its parent. */
export const childDaysFromParent = <T extends number | null>(
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

/** A parent's fixed day count, or null when the buyer chooses it. */
export const fixedParentDays = (
  parent: Pick<
    ListingWithCount,
    "customisable_days" | "duration_days" | "listing_type"
  >,
): number | null =>
  childDaysFromParent<number | null>(
    parent,
    null,
    normalizeDurationDays(parent.duration_days),
  );

/** Keeps options that at least one child can support. */
export const keepOptionsSomeChildSupports = <T>(
  options: T[],
  children: readonly TicketListing[],
  canUseChild: (child: TicketListing) => boolean,
  optionsForChild: (child: TicketListing) => T[],
): T[] => {
  const supported = new Set<T>();
  for (const child of children.filter(canUseChild)) {
    for (const value of optionsForChild(child)) supported.add(value);
  }
  return options.filter((value) => supported.has(value));
};

/** Runs a step for each listing that has children, carrying the result along. */
export const updateForMembersWithChildren = <T>(
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

/** Builds listing availability for ticket pages before a date is chosen. A
 * listing without the `dateLessCap` rule has no date-less own count — its cap
 * is per-date, checked once a date is known — so no ceiling applies here. */
export const buildTicketListing = (
  listing: ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  const listingRemaining = hasCapacityRule("dateLessCap")(listing)
    ? listing.max_attendees - listing.attendee_count
    : Number.POSITIVE_INFINITY;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);
  return { isClosed: closed, isSoldOut, listing, maxPurchasable };
};

/** Day counts every customisable listing on the page supports. */
export const dayCountsEveryListingSupports = (
  listings: TicketListing[],
): number[] => {
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

/** Day counts a required child supports, or null when any count is fine. */
export const dayCountsChildSupports = (
  child: TicketListing,
): number[] | null => {
  if (child.listing.customisable_days) return availableDayCounts(child.listing);
  if (child.listing.listing_type === "daily") {
    return [normalizeDurationDays(child.listing.duration_days)];
  }
  return null;
};

/** Keeps day counts that each member's children can support. */
export const keepDayCountsChildrenSupport = (
  members: TicketListing[],
  counts: number[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
): number[] =>
  updateForMembersWithChildren(
    members,
    childrenByParentId,
    counts,
    (current, _member, children) =>
      keepOptionsSomeChildSupports(
        current,
        children,
        childCanBePickedBeforeDays,
        (child) => dayCountsChildSupports(child) ?? current,
      ),
  );

/** Keeps parent day counts that at least one child can support. */
export const keepParentDayCountsChildrenSupport = (
  listings: TicketListing[],
  parentDayCounts: number[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]> | undefined,
): number[] =>
  !childrenByParentId || listings.length !== 1
    ? parentDayCounts
    : keepDayCountsChildrenSupport(
        listings,
        parentDayCounts,
        childrenByParentId,
      );

/** Package day counts that all parent members and children can support. */
export const packageDayCountsChildrenSupport = (
  listings: TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
): number[] =>
  keepDayCountsChildrenSupport(
    listings,
    dayCountsEveryListingSupports(listings),
    childrenByParentId,
  );
