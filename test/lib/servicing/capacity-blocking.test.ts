/**
 * Servicing §2 — capacity blocking (the headline behaviour).
 *
 * A servicing hold is a real booking row, so it must consume listing capacity
 * exactly the way a customer booking does — that's the whole point: it blocks
 * the date for customers. These integration tests prove the hold flows through
 * `checkListingAvailability` / `checkLinesCapacity` / group-cap paths, that
 * deletion restores capacity, and that `allowOverbook` lets an operator close
 * a day past the cap.
 *
 * Implementation contract (test-first):
 *   - `#shared/db/attendees/servicing.ts` exports `createServicingEvent`,
 *     `deleteServicingEvent` (see `#test-utils/servicing.ts`).
 *   - A servicing event writes `listing_attendees` rows with the held quantity
 *     and range, so the existing capacity readers see it without a special case.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkListingAvailability,
  getGroupRemainingForListing,
  getListingRemainingForRange,
} from "#shared/db/attendees/capacity.ts";
import { hasAvailableSpots } from "#shared/db/attendees.ts";
import {
  createDailyTestListing,
  createServicingHold,
  createTestGroup,
  createTestListing,
  deleteServicingEvent,
  describeWithEnv,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("servicing §2 — capacity blocking", { db: true }, () => {
  test("a servicing hold reduces availability for its date range", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 5 });
    expect(await checkListingAvailability(listing.id, 1, "2026-07-01")).toBe(
      true,
    );
    await createServicingHold({
      date: "2026-07-01",
      listing: { maxAttendees: 5 },
      quantity: 2,
    });
    // 5 − 2 = 3 remain; the hold ate 2 spots.
    expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(3);
  });

  test("a customer booking is rejected once servicing fills the listing", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 3 });
    await createServicingHold({
      date: "2026-07-01",
      listing: { maxAttendees: 3 },
      name: "Close Day",
      quantity: 3,
    });
    // A customer asking for 1 spot is now refused — even though 1 alone would
    // have fit before the hold (metamorphic: capacity fell by exactly 3).
    expect(await checkListingAvailability(listing.id, 1, "2026-07-01")).toBe(
      false,
    );
  });

  test("servicing only blocks overlapping days (half-open range)", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 5 });
    // A two-day hold [2026-07-01, 2026-07-03) covers 07-01 and 07-02 only.
    await createServicingHold({
      date: "2026-07-01",
      durationDays: 2,
      listing: { maxAttendees: 5 },
      name: "Two-Day Service",
      quantity: 4,
    });
    expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(1);
    expect(await getListingRemainingForRange(listing.id, "2026-07-02")).toBe(1);
    // Adjacent days are untouched.
    expect(await getListingRemainingForRange(listing.id, "2026-06-30")).toBe(5);
    expect(await getListingRemainingForRange(listing.id, "2026-07-03")).toBe(5);
  });

  test("deleting a servicing event restores capacity", async () => {
    const { id, listing } = await createServicingHold({
      date: "2026-07-01",
      listing: { maxAttendees: 5 },
      quantity: 3,
    });
    expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(2);
    await deleteServicingEvent(id);
    expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(5);
  });

  test("servicing consumes group-level capacity", async () => {
    const group = await createTestGroup({
      maxAttendees: 4,
      name: "g",
      slug: "g",
    });
    const listing = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "group-listing",
    });
    await createServicingHold({
      date: "2026-07-01",
      listing: { groupId: group.id, maxAttendees: 10, name: "group-listing" },
      name: "Group Service",
      quantity: 2,
    });
    // The group cap (4) drops by the held quantity (2).
    expect(await getGroupRemainingForListing(listing.id, "2026-07-01")).toBe(2);
  });

  test("group remaining returns undefined for a missing listing id", async () => {
    expect(
      await getGroupRemainingForListing(999_999, "2026-07-01"),
    ).toBeUndefined();
  });

  test("listing range remaining returns undefined for a missing listing id", async () => {
    expect(
      await getListingRemainingForRange(999_999, "2026-07-01"),
    ).toBeUndefined();
  });

  test("servicing on a standard listing consumes cumulative capacity", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await createServicingHold({
      listing: { maxAttendees: 5 },
      name: "Standard Hold",
      quantity: 2,
    });
    // A date-less standard listing tracks a single cumulative total: 5 − 2 = 3.
    expect(await hasAvailableSpots(listing.id, 1)).toBe(true);
    expect(await hasAvailableSpots(listing.id, 4)).toBe(false);
  });

  test("servicing may overbook when allowOverbook is set (close a day past the cap)", async () => {
    const listing = await createDailyTestListing({ maxAttendees: 2 });
    // Holding 5 against a cap of 2 would normally be rejected; an operator
    // closing the day opts into overbook.
    const { id } = await createServicingHold({
      allowOverbook: true,
      date: "2026-07-01",
      listing: { maxAttendees: 2 },
      name: "Overbook Close",
      quantity: 5,
    });
    expect(id).toBeGreaterThan(0);
    expect(await getListingRemainingForRange(listing.id, "2026-07-01")).toBe(
      -3,
    );
  });
});
