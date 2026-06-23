import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkBatchAvailability } from "#shared/db/attendees.ts";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > checkBatchAvailability", { db: true }, () => {
  test("returns true for empty items", async () => {
    expect(await checkBatchAvailability([])).toBe(true);
  });

  test("returns false when listing not found", async () => {
    expect(
      await checkBatchAvailability([{ listingId: 999, quantity: 1 }]),
    ).toBe(false);
  });

  test("checks per-date capacity for daily listings", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 2 });
    await bookAttendee(listing, { date: "2026-05-01", quantity: 2 });
    expect(
      await checkBatchAvailability(
        [{ listingId: listing.id, quantity: 1 }],
        "2026-05-01",
      ),
    ).toBe(false);
    expect(
      await checkBatchAvailability(
        [{ listingId: listing.id, quantity: 2 }],
        "2026-05-02",
      ),
    ).toBe(true);
  });

  test("rejects a multi-day booking when any day in the range is at capacity", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(listing, {
      date: "2026-05-02",
      durationDays: 1,
      quantity: 2,
    });
    expect(
      await checkBatchAvailability(
        [{ durationDays: 3, listingId: listing.id, quantity: 1 }],
        "2026-05-01",
      ),
    ).toBe(false);
  });

  test("accepts a multi-day booking when every day has room", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    expect(
      await checkBatchAvailability(
        [{ durationDays: 3, listingId: listing.id, quantity: 1 }],
        "2026-05-01",
      ),
    ).toBe(true);
  });

  test("admits a 1-day booking in the gap between two full days", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(listing, {
      date: "2026-05-01",
      durationDays: 1,
      quantity: 2,
    });
    await bookAttendee(listing, {
      date: "2026-05-03",
      durationDays: 1,
      quantity: 2,
    });
    expect(
      await checkBatchAvailability(
        [{ durationDays: 1, listingId: listing.id, quantity: 2 }],
        "2026-05-02",
      ),
    ).toBe(true);
  });

  test("enforces group per-day cap across Saturday/Sunday/combo scenario", async () => {
    const group = await createTestGroup({ maxAttendees: 100 });
    const sat = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
    });
    const sun = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
    });
    const combo = await createDailyTestListing({
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(sat, { date: "2026-05-02", quantity: 50 });
    await bookAttendee(combo, {
      date: "2026-05-02",
      durationDays: 2,
      quantity: 50,
    });
    expect(
      await checkBatchAvailability(
        [{ listingId: sat.id, quantity: 1 }],
        "2026-05-02",
      ),
    ).toBe(false);
    expect(
      await checkBatchAvailability(
        [{ listingId: sun.id, quantity: 50 }],
        "2026-05-03",
      ),
    ).toBe(true);
  });

  test("rejects negative quantities", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    expect(
      await checkBatchAvailability([{ listingId: listing.id, quantity: -1 }]),
    ).toBe(false);
  });

  test("rejects a standard listing exceeding total capacity", async () => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 2,
    });
    await bookAttendee(listing, { quantity: 2 });
    expect(
      await checkBatchAvailability([{ listingId: listing.id, quantity: 1 }]),
    ).toBe(false);
  });

  test("uses the editable booked quantity for standard listing capacity", async () => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 5,
    });
    await updateListingAggregateValues(listing.id, {
      booked_quantity: 5,
      tickets_count: 0,
    });
    expect(
      await checkBatchAvailability([{ listingId: listing.id, quantity: 1 }]),
    ).toBe(false);
  });

  test("stays within a constant query budget for a large cart", async () => {
    // More daily listings than the N+1 read guard threshold (25): a per-listing
    // fan-out would run the occupancy read once each and trip the guard.
    const items: { listingId: number; quantity: number }[] = [];
    for (let i = 0; i < 28; i++) {
      const listing = await createDailyTestListing({ maxAttendees: 5 });
      items.push({ listingId: listing.id, quantity: 1 });
    }
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      expect(await checkBatchAvailability(items, "2026-05-01")).toBe(true);
      // Listing rows + batched occupancy + group caps — a small constant.
      expect(getQueryLog().length).toBeLessThanOrEqual(5);
    });
  });
});
