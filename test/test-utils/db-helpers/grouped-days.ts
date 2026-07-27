import type { Group, ListingWithCount } from "#shared/types.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";

/**
 * Two daily listings in one capped group, each booked on its own day.
 * Extending listing A to span listing B's day is what pushes the group over
 * its cap, so this is the shared setup behind the duration-change checks —
 * parameterised by the group cap, the quantity on each listing, and the two
 * days. `secondQuantity` defaults to the same quantity as the first.
 */
export const twoGroupedListingsBookedOnAdjacentDays = async (opts: {
  cap: number;
  quantity: number;
  secondQuantity?: number;
  dateA: string;
  dateB: string;
}): Promise<{
  group: Group;
  listingA: ListingWithCount;
  listingB: ListingWithCount;
}> => {
  const group = await createTestGroup({ maxAttendees: opts.cap });
  const makeListing = () =>
    createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 60,
      thankYouUrl: "",
    });
  const listingA = await makeListing();
  const listingB = await makeListing();
  await bookAttendee(listingA, { date: opts.dateA, quantity: opts.quantity });
  await bookAttendee(listingB, {
    date: opts.dateB,
    quantity: opts.secondQuantity ?? opts.quantity,
  });
  return { group, listingA, listingB };
};
