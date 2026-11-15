/** Group capacity fixtures: capped groups, their member listings, and the
 *  batch capacity question the capacity tests ask. */

import { checkBatchAvailabilityImpl as checkBatchAvailability } from "#db/attendees/capacity/checks.ts";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

/** A capped group with two listings, each with a listing-level cap of 10. */
export const createCappedGroupWithListings = async (
  groupMax: number,
  slug: string,
  overrides?: { listingType?: "standard" | "daily" },
) => {
  const group = await createTestGroup({
    maxAttendees: groupMax,
    name: slug,
    slug,
  });
  const members: ListingWithCount[] = [];
  for (const suffix of ["a", "b"]) {
    members.push(
      await createTestListing({
        groupId: group.id,
        ...(overrides?.listingType !== undefined
          ? { listingType: overrides.listingType }
          : {}),
        maxAttendees: 10,
        name: `${slug}-${suffix}`,
      }),
    );
  }
  const [e1, e2] = members;
  if (e1 === undefined || e2 === undefined) {
    throw new Error(
      "createCappedGroupWithListings made fewer than two members",
    );
  }
  return { e1, e2, group };
};

/** Book attendees atomically with minimal boilerplate. The generated
 *  email/name is keyed by `listingId`+`quantity` so distinct bookings
 *  within a test never collide. */
export const book = (listingId: number, quantity: number, date?: string) =>
  createAttendeeAtomic({
    bookings: [
      { ...(date !== undefined ? { date } : {}), listingId, quantity },
    ],
    email: `g${listingId}q${quantity}@example.com`,
    name: `g-${listingId}-${quantity}`,
  });

/** A member listing of `group`, with the listing-level cap it carries. */
export const memberListing = (
  group: { id: number },
  name: string,
  maxAttendees = 10,
) => createTestListing({ groupId: group.id, maxAttendees, name });

/** A group with the given fields and one member listing beneath it. */
export const groupWithListing = async (
  fields: Parameters<typeof createTestGroup>[0],
  listingName: string,
  maxAttendees = 10,
) => {
  const group = await createTestGroup(fields);
  return {
    group,
    listing: await memberListing(group, listingName, maxAttendees),
  };
};

/** A capped group's two listings, with `e1` already booked by `quantity`. */
export const bookedCappedGroup = async (
  max: number,
  slug: string,
  quantity: number,
) => {
  const { e1, e2, group } = await createCappedGroupWithListings(max, slug);
  await book(e1.id, quantity);
  return { e1, e2, group };
};

/** Whether one batch books these quantities, on `date` when given. */
export const batchFits = (
  entries: readonly (readonly [listing: { id: number }, quantity: number])[],
  date?: string,
) =>
  checkBatchAvailability(
    entries.map(([listing, quantity]) => ({
      listingId: listing.id,
      quantity,
    })),
    date,
  );
