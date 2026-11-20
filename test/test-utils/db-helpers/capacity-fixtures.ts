import { listingAggregates } from "#db/listings/aggregates.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { Group, ListingWithCount } from "#types";

/**
 * Fixtures for the capacity rules: a capped group and its member listings, a
 * daily listing that already holds bookings, and carts of independent
 * listings. The preflight, the write guard, the refusal diagnosis and the
 * remaining-count reads all start from these stored shapes.
 */

/** Write a listing's stored booked quantity with no ticket count behind it, so
 * the listing reads as booked without an attendee row to match. */
export const setStoredBookedQuantity = async (
  listingId: number,
  bookedQuantity: number,
): Promise<void> => {
  await listingAggregates.update(listingId, {
    bookedQuantity: bookedQuantity,
    ticketsCount: 0,
  });
};

/** `count` listings of one kind, each with `maxAttendees` places, in `group`
 * when one is given. A daily listing answers per-day checks; a standard
 * listing carries one running total on every date. */
export const createListings = async (opts: {
  count: number;
  maxAttendees: number;
  daily?: boolean;
  group?: Group;
}): Promise<ListingWithCount[]> => {
  const listings: ListingWithCount[] = [];
  for (let index = 0; index < opts.count; index++) {
    const overrides = {
      maxAttendees: opts.maxAttendees,
      ...(opts.group !== undefined && { groupId: opts.group.id }),
    };
    listings.push(
      opts.daily
        ? await createDailyTestListing(overrides)
        : await createTestListing(overrides),
    );
  }
  return listings;
};

/** A capped group with `count` member listings, each with `maxAttendees`
 * places (default 100), so only the shared cap can bind a cart. */
export const groupWithMembers = async (opts: {
  cap: number;
  count: number;
  maxAttendees?: number;
  daily?: boolean;
}): Promise<{ group: Group; members: ListingWithCount[] }> => {
  const group = await createTestGroup({ maxAttendees: opts.cap });
  const members = await createListings({
    count: opts.count,
    group,
    maxAttendees: opts.maxAttendees ?? 100,
    ...(opts.daily !== undefined && { daily: opts.daily }),
  });
  return { group, members };
};

/** The one daily member of a group capped at `cap`, for the tests that read
 * the member alone. */
export const dailyMemberOfGroup = async (
  cap: number,
  maxAttendees = 10,
): Promise<ListingWithCount> => {
  const { members } = await groupWithMembers({
    cap,
    count: 1,
    daily: true,
    maxAttendees,
  });
  return members[0]!;
};

/** A capped group holding one daily and one standard member, each roomy on its
 * own, so only the shared group cap can bind a cart that spans both. */
export const groupWithDailyAndStandardMember = async (
  cap: number,
  maxAttendees = 10,
): Promise<{ daily: ListingWithCount; standard: ListingWithCount }> => {
  const group = await createTestGroup({ maxAttendees: cap });
  const daily = await createDailyTestListing({
    groupId: group.id,
    maxAttendees,
  });
  const standard = await createTestListing({
    groupId: group.id,
    maxAttendees,
  });
  return { daily, standard };
};

/** A roomy daily listing beside a standard listing that already carries
 * `booked` of its `standardCap` places, so only the standard line's running
 * total can bind a cart that spans both. */
export const dailyListingBesideBookedStandard = async (opts: {
  standardCap: number;
  booked: number;
}): Promise<{ daily: ListingWithCount; standard: ListingWithCount }> => {
  const standard = await createTestListing({
    maxAttendees: opts.standardCap,
  });
  await bookAttendee(standard, { quantity: opts.booked });
  const daily = await createDailyTestListing({ maxAttendees: 5 });
  return { daily, standard };
};

/** A daily listing that spans `durationDays` when given, with one one-day
 * booking of `quantity` places on each entry's `day`. A booking of the
 * listing's whole capacity leaves that day full. */
export const dailyListingBooked = async (opts: {
  booked: { day: string; quantity: number }[];
  maxAttendees: number;
  durationDays?: number;
}): Promise<ListingWithCount> => {
  const listing = await createDailyTestListing({
    maxAttendees: opts.maxAttendees,
    ...(opts.durationDays !== undefined && { durationDays: opts.durationDays }),
  });
  for (const { day, quantity } of opts.booked) {
    await bookAttendee(listing, { date: day, durationDays: 1, quantity });
  }
  return listing;
};
