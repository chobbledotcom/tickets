import { intersect } from "@std/collections";
import type { CartLengthItem } from "#shared/booking/cart-conflicts.ts";
import { hasDateLessCap } from "#shared/capacity-rules.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import {
  ascending,
  availableDayCounts,
  clampDurationDays,
  dayPriceFor,
  type Holiday,
  type ListingWithCount,
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

/** Each parent listing's children, keyed by the parent's listing id. */
export type ChildrenByParent = ReadonlyMap<number, readonly TicketListing[]>;

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
    clampDurationDays(child.listing.duration_days) === days;

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

/** Checks a child can still be booked, before any date or day count is chosen
 * (a daily child's date checks come later, once the buyer picks one). */
export const childCanBeBooked: (child: TicketListing) => boolean =
  childPassesAllChecks([childActive, childOpen, childInStock]);

/** Child ids that can still be booked. */
export const bookableChildIds = (
  childrenByParentId: ChildrenByParent | undefined,
): ReadonlySet<number> =>
  new Set(
    [...(childrenByParentId?.values() ?? [])]
      .flat()
      .filter(childCanBeBooked)
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
    return clampDurationDays(parent.duration_days) as T;
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
    clampDurationDays(parent.duration_days),
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

/** A listing paired with its own children. */
export type MemberWithChildren = {
  member: TicketListing;
  children: readonly TicketListing[];
};

/** The listings that actually have children, each paired with them. */
export const membersWithChildren = (
  members: readonly TicketListing[],
  childrenByParentId: ChildrenByParent | undefined,
): MemberWithChildren[] =>
  members.flatMap((member) => {
    const children = childrenByParentId?.get(member.listing.id);
    return !children || children.length === 0 ? [] : [{ children, member }];
  });

/** Runs a step for each listing that has children, carrying the result along. */
export const updateForMembersWithChildren = <T>(
  members: readonly TicketListing[],
  childrenByParentId: ChildrenByParent,
  initial: T,
  step: (
    current: T,
    member: TicketListing,
    children: readonly TicketListing[],
  ) => T,
): T =>
  membersWithChildren(members, childrenByParentId).reduce(
    (current, { member, children }) => step(current, member, children),
    initial,
  );

/** Builds listing availability for ticket pages before a date is chosen. A
 * listing without the `dateLessCap` rule has no date-less own count — its cap
 * is per-date, checked once a date is known — so no ceiling applies here. */
export const buildTicketListing = (
  listing: ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  const listingRemaining = hasDateLessCap(listing)
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

/** Each customisable listing on the page with the day counts it supports on
 * its own — the booking-length facts the cart conflict rules read. */
export const customisableLengthItems = (
  listings: TicketListing[],
): CartLengthItem[] =>
  listings
    .filter((listing) => listing.listing.customisable_days)
    .map((listing) => ({
      dayCounts: availableDayCounts(listing.listing),
      name: listing.listing.name,
    }));

/** Day counts every customisable listing on the page supports. */
const dayCountsEveryListingSupports = (listings: TicketListing[]): number[] => {
  const items = customisableLengthItems(listings);
  if (items.length === 0) return [];
  return intersect(...items.map((item) => item.dayCounts)).sort(ascending);
};

/** Day counts a required child supports, or null when any count is fine. */
export const dayCountsChildSupports = (
  child: TicketListing,
): number[] | null => {
  if (child.listing.customisable_days) return availableDayCounts(child.listing);
  if (child.listing.listing_type === "daily") {
    return [clampDurationDays(child.listing.duration_days)];
  }
  return null;
};

/** Keeps day counts that each member's children can support. */
const keepDayCountsChildrenSupport = (
  members: TicketListing[],
  counts: number[],
  childrenByParentId: ChildrenByParent,
): number[] =>
  updateForMembersWithChildren(
    members,
    childrenByParentId,
    counts,
    (current, _member, children) =>
      keepOptionsSomeChildSupports(
        current,
        children,
        childCanBeBooked,
        (child) => dayCountsChildSupports(child) ?? current,
      ),
  );

/** Day counts the page's "number of days" selector can offer. Starts from the
 * counts every customisable listing supports, then keeps only counts the
 * required children can serve. A package page books every member, so each
 * parent member's child union constrains the bundle's spans; every other page
 * constrains only the single-listing-parent case. */
export const pageDayCounts = (
  listings: TicketListing[],
  childrenByParentId: ChildrenByParent | undefined,
  hasPackages: boolean,
): number[] => {
  const counts = dayCountsEveryListingSupports(listings);
  return childrenByParentId && (hasPackages || listings.length === 1)
    ? keepDayCountsChildrenSupport(listings, counts, childrenByParentId)
    : counts;
};
