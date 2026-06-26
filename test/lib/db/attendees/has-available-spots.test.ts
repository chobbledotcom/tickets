import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

const createCappedListingWithJohn = async () => {
  const listing = await createTestListing({ maxAttendees: 2 });
  await createTestAttendee(
    listing.id,
    listing.slug,
    "John",
    "john@example.com",
  );
  return listing;
};

const expectHasAvailableSpots = async (id: number, expected: boolean) => {
  expect(await hasAvailableSpots(id)).toBe(expected);
};

const setupGroupCappedSibling = async (
  groupMax: number,
  listingDurationDays: number,
  listingMaxAttendees: number,
  bookingDate: string,
  bookingQuantity: number,
) => {
  const group = await createTestGroup({ maxAttendees: groupMax });
  const listing = await createDailyTestListing({
    durationDays: listingDurationDays,
    groupId: group.id,
    maxAttendees: listingMaxAttendees,
  });
  const sibling = await createDailyTestListing({
    groupId: group.id,
    maxAttendees: 100,
  });
  await bookAttendee(sibling, { date: bookingDate, quantity: bookingQuantity });
  return { group, listing, sibling };
};

describeWithEnv("db > attendees > hasAvailableSpots", { db: true }, () => {
  test("returns false for non-existent listing", async () => {
    const result = await hasAvailableSpots(999);
    expect(result).toBe(false);
  });

  test("returns true when spots available", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    expect(await hasAvailableSpots(listing.id)).toBe(true);
  });

  test("returns true when some spots taken", async () => {
    const listing = await createCappedListingWithJohn();
    await expectHasAvailableSpots(listing.id, true);
  });

  test("returns false when listing is full", async () => {
    const listing = await createCappedListingWithJohn();
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Jane",
      "jane@example.com",
    );
    await expectHasAvailableSpots(listing.id, false);
  });

  test("checks per-date capacity for daily listings", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 1 });
    await bookAttendee(listing, { date: "2026-02-10" });
    expect(await hasAvailableSpots(listing.id, 1, "2026-02-10")).toBe(false);
    expect(await hasAvailableSpots(listing.id, 1, "2026-02-11")).toBe(true);
  });

  test("multi-day range: every day must have room (listing cap)", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(listing, {
      date: "2026-05-03",
      durationDays: 1,
      quantity: 2,
    });
    expect(await hasAvailableSpots(listing.id, 1, "2026-05-01", 3)).toBe(false);
    expect(await hasAvailableSpots(listing.id, 1, "2026-05-01", 1)).toBe(true);
  });

  test("multi-day range: every day must have room (group cap)", async () => {
    const { listing } = await setupGroupCappedSibling(
      2,
      2,
      100,
      "2026-05-02",
      2,
    );
    expect(await hasAvailableSpots(listing.id, 1, "2026-05-01", 2)).toBe(false);
  });

  test("multi-day range: an uncapped group never limits availability", async () => {
    const { listing } = await setupGroupCappedSibling(
      0,
      3,
      5,
      "2026-05-02",
      50,
    );
    expect(await hasAvailableSpots(listing.id, 1, "2026-05-01", 3)).toBe(true);
  });

  test("multi-day range: non-daily group rows count against every day", async () => {
    // Groups normally hold one listing type, but an listing can be flipped
    // after booking — its rows must then count on every day of the range
    // (the `listing_type != 'daily'` arm of the group predicate).
    const { listing, sibling } = await setupGroupCappedSibling(
      5,
      2,
      100,
      "2026-09-01",
      3,
    );
    const { getDb } = await import("#shared/db/client.ts");
    await getDb().execute({
      args: [sibling.id],
      sql: "UPDATE listings SET listing_type = 'standard' WHERE id = ?",
    });
    // Sibling's 3 now count on every day — a 2-day booking far from
    // 2026-09-01 still only has 5 - 3 = 2 group spots per day.
    expect(await hasAvailableSpots(listing.id, 3, "2026-11-01", 2)).toBe(false);
    expect(await hasAvailableSpots(listing.id, 2, "2026-11-01", 2)).toBe(true);
  });

  test("checks a grouped daily listing without a query per day or group", async () => {
    const group = await createTestGroup({ maxAttendees: 5 });
    const listing = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 5,
    });
    await bookAttendee(listing, { date: "2026-05-01", quantity: 1 });
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      expect(await hasAvailableSpots(listing.id, 1, "2026-05-01")).toBe(true);
      // One capacity query (listing + group caps, all days) plus the listing
      // lookup — not the overlap + two group reads the old code ran.
      expect(getQueryLog().length).toBeLessThanOrEqual(2);
    });
  });
});
