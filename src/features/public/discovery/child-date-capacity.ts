/** One required child's date capacity for the daily date filter: the most
 *  units the child can serve on one exact date, after its own gates.
 *
 *  Pure: the facts arrive already loaded, so the branches are testable
 *  without the site, and the coverage merger sees them exercised from one
 *  isolate. */

/* jscpd:ignore-start */
import { buildTicketListing, childActive, childOpen } from "#booking/model.ts";
import type { Holiday } from "#db/holidays.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  type ChildCapacityPart,
  childCapacityPartsFor,
} from "#shared/capacity-fit.ts";
/* jscpd:ignore-end */
import type { ListingWithCount } from "#types";
import {
  childOfferedOnDate,
  childStartDates,
  type ParentDayCounts,
} from "./child-offered.ts";

/** The facts one required child's date capacity reads, bound once per page
 *  walk so the per-child rule stays a named function. */
export type ChildDateCapacityCtx = {
  date: string;
  dayCounts: ParentDayCounts;
  holidays: readonly Holiday[];
  /** Raw remaining per judged listing id — the map carries every judged
   *  listing, so a child's own read cannot miss. */
  remaining: ReadonlyMap<number, number>;
};

/** The most units one required child can serve on the page's date, after
 *  its own gates. An inactive child, a closed child, or a daily child that
 *  cannot start on this date serves none. Raw remaining lets the date
 *  filter advertise a parent the discovery cards read as sold out. */
export const childDateCapacity = (
  child: ListingWithCount,
  ctx: ChildDateCapacityCtx,
): number => {
  const info = buildTicketListing(
    child,
    isRegistrationClosed(child),
    ctx.remaining.get(child.id)!,
  );
  if (!childActive(info) || !childOpen(info)) return 0;
  const offered = childOfferedOnDate(
    info,
    ctx.holidays,
    ctx.dayCounts,
    childStartDates(info, ctx.holidays),
    ctx.date,
  );
  return offered ? info.maxPurchasable : 0;
};

/** The capacity parts of one parent's required children on the page's date:
 *  each child's group pools and its gated date capacity. */
export const childDateCapacityParts = (
  children: readonly ListingWithCount[],
  groupIdsByListingId: ReadonlyMap<number, readonly number[]>,
  ctx: ChildDateCapacityCtx,
): ChildCapacityPart[] =>
  childCapacityPartsFor(
    groupIdsByListingId,
    children,
    (child) => child.id,
    (child) => childDateCapacity(child, ctx),
  );
