import {
  bookAttendee,
  createDailyTestListing,
  createTestGroup,
} from "#test-utils";

/**
 * Two daily listings in one capped group, each booked on its own day.
 * Extending listing A to span listing B's day is what pushes the group over
 * its cap in the duration-change tests — the shared setup behind several of
 * them, parameterised by the group cap, per-listing quantity, and the two days.
 */
export const twoGroupedListingsBookedOnAdjacentDays = async (opts: {
  cap: number;
  quantity: number;
  dateA: string;
  dateB: string;
}) => {
  const group = await createTestGroup({ maxAttendees: opts.cap });
  const makeListing = () =>
    createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maximumDaysAfter: 60,
    });
  const listingA = await makeListing();
  const listingB = await makeListing();
  await bookAttendee(listingA, { date: opts.dateA, quantity: opts.quantity });
  await bookAttendee(listingB, { date: opts.dateB, quantity: opts.quantity });
  return { group, listingA, listingB };
};
