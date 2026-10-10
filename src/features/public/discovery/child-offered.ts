/** Whether one child listing can fold under a parent ticket that starts on
 *  `date`. Pure: the facts arrive already loaded, and the calendar rule is
 *  the booking model's own, so the answer is testable without the site.
 *
 *  A `null` date is the date-less gate: the child must fold on some date
 *  the parent offers, because the page carries no date selector. Children
 *  that fold on different dates must not sum: no single date can carry
 *  child units from calendars that never share one. */

import {
  childHasDateOrStockForDays,
  childInStock,
  childSupportsDays,
  fixedParentDays,
  type TicketListing,
} from "#booking/model.ts";
import type { Holiday } from "#db/holidays.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import {
  availableDayCounts,
  clampDurationDays,
  type ListingWithCount,
} from "#types";

/** Day counts the parent can pass to a daily child: a customisable daily
 *  parent offers every start day, a fixed daily parent offers its duration. */
export type ParentDayCounts = (number | null)[];

/** The day counts the parent's booking form offers a child. */
export const parentOfferedDayCounts = (
  parent: ListingWithCount,
): ParentDayCounts =>
  parent.listing_type === "daily" && parent.customisable_days
    ? availableDayCounts(parent)
    : [fixedParentDays(parent)];

/** The day counts a DAILY parent's fold can book: a fixed parent books its
 *  duration, a customisable one a count it prices. A daily parent's counts
 *  are always numbers — the buyer's span is the open choice, never a
 *  missing one. */
export const dailyOfferedDayCounts = (parent: ListingWithCount): number[] =>
  parent.customisable_days
    ? availableDayCounts(parent)
    : [clampDurationDays(parent.duration_days)];

/** The child's own bookable start dates, computed once per child: the
 *  per-date gate reads them for every date the parent offers. */
export const childStartDates = (
  child: TicketListing,
  holidays: readonly Holiday[],
): string[] => getBookableStartDates(child.listing, [...holidays]);

/** Whether the child can serve the span one offered day count books. A
 *  `null` count names a span the buyer has not chosen yet. No served span
 *  can miss it, and the fold judges the chosen count at submit. */
const childServesCount = (child: TicketListing, days: number | null): boolean =>
  days === null || childSupportsDays(child, days);

/** Whether the parent offers any date a child can fold on, before any date
 *  is chosen. The parent's own calendar answers for a daily parent. A
 *  non-daily parent carries no calendar and needs only stock. A count the
 *  child cannot serve at the till is not offered. The form books one
 *  count, and the fold refuses a child whose span misses it. */
export const childOfferedWithoutDate = (
  child: TicketListing,
  holidays: readonly Holiday[],
  dayCounts: ParentDayCounts,
  parentDates: ReadonlySet<string> | null,
): boolean =>
  dayCounts.some(
    (days) =>
      childServesCount(child, days) &&
      childHasDateOrStockForDays([...holidays], days, parentDates)(child),
  );

/** Whether the child holds the offered span on one exact date: the booking
 *  model's calendar rule reads the child's span over the parent's day count.
 *  A `null` count books the one-day span. */
const childBookableForSpan = (
  child: TicketListing,
  date: string,
  holidays: readonly Holiday[],
  days: number | null,
): boolean =>
  isBookingRangeValid(child.listing, date, days ?? 1, [...holidays]);

/** Whether the child can fold on one exact date. A non-daily child needs
 *  only stock. A daily child must start that date and hold the span. The
 *  span is one of the parent's offered day counts, and the child must serve
 *  it. The fold books one count and refuses a child whose span misses it.
 *  `starts` is the child's own bookable start dates, computed once by the
 *  caller. */
export const childOfferedOnDate = (
  child: TicketListing,
  holidays: readonly Holiday[],
  dayCounts: ParentDayCounts,
  starts: readonly string[],
  date: string,
): boolean => {
  if (child.listing.listing_type !== "daily") return childInStock(child);
  if (!starts.includes(date)) return false;
  return dayCounts.some(
    (days) =>
      childServesCount(child, days) &&
      childBookableForSpan(child, date, holidays, days),
  );
};
