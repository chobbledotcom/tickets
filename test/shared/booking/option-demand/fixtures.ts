/**
 * The shared fixtures of the option-demand case table: the availability-
 * resolved row builders and the two named listing pairs the capacity and
 * span cases reuse.
 */

import {
  buildTicketListing,
  type ChildrenByParent,
  type TicketListing,
} from "#booking/model.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { loadChildrenByParentId } from "#routes/public/child-listings.ts";
import { addDays } from "#shared/dates.ts";
import { orderDate } from "#test/features/public/order/helpers.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";

/** The availability-resolved listing row one fixture id stands for. */
export const ticketInfo = async (id: number): Promise<TicketListing> =>
  buildTicketListing((await getListingWithCount(id))!, false, undefined);

/** The children of one parent set, availability-resolved. */
export const resolvedChildren = async (
  parentIds: number[],
): Promise<ChildrenByParent> => {
  const infos = await Promise.all(parentIds.map(ticketInfo));
  return loadChildrenByParentId(infos);
};

/** Books one unit of a listing for one day on the day after the order date,
 * the way the capacity fixtures drain one date's pool. */
export const bookOneUnitTomorrow = async (listingId: number): Promise<void> => {
  await bookAttendee(
    { id: listingId },
    {
      date: addDays(orderDate(), 1),
      durationDays: 1,
    },
  );
};

/** A fixed three-day parent whose sole customisable child prices 1-3 days
 * with one spot. */
export const createSpanKitPair = async () => {
  const child = await createDailyTestListing({
    customisableDays: true,
    dayPrices: { 1: 500, 2: 900, 3: 1200 },
    durationDays: 3,
    maxAttendees: 1,
    name: "Span Kit",
  });
  const parent = await createDailyTestListing({
    durationDays: 3,
    name: "Three Day Trip",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

/** A fixed three-day weekday parent whose sole customisable child serves
 * early weekdays only. */
export const createEarlyWeekPair = async () => {
  const child = await createDailyTestListing({
    bookableDays: ["Monday", "Tuesday", "Wednesday"],
    customisableDays: true,
    dayPrices: { 1: 500, 2: 900, 3: 1200 },
    durationDays: 3,
    name: "Early Week Kit",
  });
  const parent = await createDailyTestListing({
    durationDays: 3,
    name: "Weekday Trip",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};
