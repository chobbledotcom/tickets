import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkBatchAvailabilityImpl as checkBatchAvailability,
  checkLinesCapacity,
} from "#db/attendees/capacity/checks.ts";
import { listingAggregates } from "#db/listings/aggregates.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > checkBatchAvailability", { db: true }, () => {
  test("returns true for empty items", async () => {
    expect(await checkBatchAvailability([])).toBe(true);
  });

  test("returns each line result in request order", async () => {
    const available = await createTestListing({ maxAttendees: 1 });
    const full = await createTestListing({ maxAttendees: 1 });
    await bookAttendee(full, { quantity: 1 });

    expect(
      await checkLinesCapacity([
        {
          date: null,
          durationDays: 1,
          listingId: available.id,
          quantity: 1,
        },
        {
          date: null,
          durationDays: 1,
          listingId: full.id,
          quantity: 1,
        },
      ]),
    ).toEqual([true, false]);
  });

  test("throws when a listing is not found", async () => {
    await expect(
      checkBatchAvailability([{ listingId: 999, quantity: 1 }]),
    ).rejects.toThrow("Listing not found: 999");
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

  test("a dated batch still counts a standard listing's demand as a running total", async () => {
    const standard = await createTestListing({ maxAttendees: 2 });
    const daily = await createDailyTestListing({ maxAttendees: 5 });
    // The standard listing's prior booking lives only in its running total —
    // its rows carry no booking range, so a per-day count would never see it.
    await bookAttendee(standard, { quantity: 1 });
    // The date belongs to the daily item; the standard listing's demand must
    // still land on its running total (1 booked + 2 > 2), not in a per-day
    // bucket where the existing booking is invisible.
    expect(
      await checkBatchAvailability(
        [
          { listingId: standard.id, quantity: 2 },
          { listingId: daily.id, quantity: 1 },
        ],
        "2026-05-01",
      ),
    ).toBe(false);
    expect(
      await checkBatchAvailability(
        [
          { listingId: standard.id, quantity: 1 },
          { listingId: daily.id, quantity: 1 },
        ],
        "2026-05-01",
      ),
    ).toBe(true);
  });

  test("a date-less batch counts a daily listing's running total", async () => {
    const daily = await createDailyTestListing({ maxAttendees: 2 });
    await bookAttendee(daily, { date: "2026-05-01", quantity: 2 });
    // With no anchor date the daily listing's demand must fall back to the
    // date-less running total (2 booked + 1 > 2), not a per-day expansion of
    // a date that does not exist.
    expect(
      await checkBatchAvailability([{ listingId: daily.id, quantity: 1 }]),
    ).toBe(false);
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

  /** One more ticket on an already-full standard listing, checked against an
   * optional cart date — the running total must reject it either way. */
  const oneMoreOnFullStandardListing = async (
    date?: string,
  ): Promise<boolean> => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 2,
    });
    await bookAttendee(listing, { quantity: 2 });
    return checkBatchAvailability(
      [{ listingId: listing.id, quantity: 1 }],
      date,
    );
  };

  test("a dated cart still counts a standard listing's running total", async () => {
    // A standard listing's rows carry no booking range, so bucketing its
    // demand per-day would count an empty overlap and admit an over-cap cart.
    expect(await oneMoreOnFullStandardListing("2026-05-01")).toBe(false);
  });

  test("rejects negative quantities", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    expect(
      await checkBatchAvailability([{ listingId: listing.id, quantity: -1 }]),
    ).toBe(false);
  });

  test("treats a zero-quantity item as a no-op that fits", async () => {
    // A zero-quantity line demands nothing, so it produces no capacity clause
    // and the cart trivially fits — exercises the empty-demand path.
    const listing = await createTestListing({ maxAttendees: 1 });
    await bookAttendee(listing, { quantity: 1 });
    expect(
      await checkBatchAvailability([{ listingId: listing.id, quantity: 0 }]),
    ).toBe(true);
  });

  test("rejects a standard listing exceeding total capacity", async () => {
    expect(await oneMoreOnFullStandardListing()).toBe(false);
  });

  test("uses the editable booked quantity for standard listing capacity", async () => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 5,
    });
    await listingAggregates.update(listing.id, {
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
