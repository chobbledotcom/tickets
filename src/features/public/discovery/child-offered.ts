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
  type TicketListing,
} from "#booking/model.ts";
import type { Holiday } from "#db/holidays.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";

/** Day counts the parent can pass to a daily child: a customisable daily
 *  parent offers every start day, a fixed daily parent offers its duration. */
export type ParentDayCounts = (number | null)[];

/** Whether the parent offers any date a child can fold on, before any date
 *  is chosen. The parent's own calendar answers for a daily parent. A
 *  non-daily parent carries no calendar and needs only stock. */
export const childOfferedWithoutDate = (
  child: TicketListing,
  holidays: readonly Holiday[],
  dayCounts: ParentDayCounts,
  parentDates: ReadonlySet<string> | null,
): boolean =>
  dayCounts.some((days) =>
    childHasDateOrStockForDays([...holidays], days, parentDates)(child),
  );

/** Whether the child can fold on one exact date. A non-daily child needs
 *  only stock. A daily child must start that date and hold it for the span
 *  one of the parent's offered day counts books. */
export const childOfferedOnDate = (
  child: TicketListing,
  holidays: readonly Holiday[],
  dayCounts: ParentDayCounts,
  date: string,
): boolean => {
  if (child.listing.listing_type !== "daily") return childInStock(child);
  const starts = getBookableStartDates(child.listing, [...holidays]);
  return dayCounts.some(
    (days) =>
      starts.includes(date) &&
      isBookingRangeValid(child.listing, date, days ?? 1, [...holidays]),
  );
};
