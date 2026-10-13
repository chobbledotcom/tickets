/**
 * The booking page's date and day-count helpers. They hold the date facts
 * the render and the cart conflict rules read. They also hold the day-count
 * resolution the submit paths share and the child-date maps the client
 * compatibility script consumes. Split from the payment flow so both files
 * stay small.
 */

/* jscpd:ignore-start -- imports */
import type { CartDateItem } from "#booking/cart-conflicts.ts";
import { childSelectableForSpan } from "#booking/fold-tree.ts";
import {
  type ChildDatesByDayCount,
  childDateKey,
  fixedParentDays,
  keepOptionsSomeChildSupports,
  type TicketListing,
  updateForMembersWithChildren,
} from "#booking/model.ts";
import { getActiveHolidays, type Holiday } from "#db/holidays.ts";
import { hydrateListingLinks, listingChildren } from "#db/listing-parents.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
/* jscpd:ignore-end */
import type { FormParams } from "#shared/form-data.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import { availableDayCounts, dayPriceFor, type ListingWithCount } from "#types";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type { ChildrenByParentId, ListingQty } from "./types.ts";

/** Parse and validate the chosen day count for "customisable days" listings.
 * Returns `{ dayCount }`. 1 when nothing selected is customisable. Returns
 * `{ error }` when the choice is missing or unpriced. For daily listings it
 * also fails when the range hits a holiday or passes the booking window.
 * `standIns` maps each concealed listing to its HIDDEN package's name. Errors
 * then name the package, never the concealed member, so the buyer's flash
 * never carries a concealed name.
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

/** Each daily listing on the page with its own bookable start dates. The cart
 * conflict rules read these facts, and the page's shared date list intersects
 * them. Customisable-days listings store duration_days as the *maximum*. Their
 * date list covers a single day: every individually-bookable start. The chosen
 * span gets validation at submit. */
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
export const keepDatesSomeChildCanServe = (
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
export const singleDailyParent = (
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
export const keepPackageDatesChildrenCanServe = (
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
