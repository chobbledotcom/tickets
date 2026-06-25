/**
 * Servicing edge cases — date boundaries.
 *
 * Year rollover, leap day, and the "today" boundary for the upcoming-events
 * filter — each a place where ISO 8601 lexicographic ordering or a `>= DATE('now')`
 * predicate can silently shift a day.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity.ts";
import {
  createDailyTestListing,
  createServicingHold,
  createTestServicingEvent,
  describeWithEnv,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("servicing edge cases — date boundaries", { db: true }, () => {
  test("a servicing hold spanning a year boundary consumes capacity for both years correctly", async () => {
    // ISO 8601 lexicographic ordering must hold across the year rollover:
    // '2026-12-31T00:00:00Z' < '2027-01-01T00:00:00Z' < '2027-01-02T00:00:00Z'.
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "L",
    });
    await createServicingHold({
      date: "2026-12-30",
      durationDays: 3,
      listing: { maxAttendees: 5, name: "L" },
      quantity: 2,
    });
    // [2026-12-30, 2027-01-02) covers 12-30, 12-31, 01-01.
    expect(await getListingRemainingForRange(listing.id, "2026-12-30")).toBe(3);
    expect(await getListingRemainingForRange(listing.id, "2026-12-31")).toBe(3);
    expect(await getListingRemainingForRange(listing.id, "2027-01-01")).toBe(3);
    // The day after the span (01-02) is excluded — the half-open boundary.
    expect(await getListingRemainingForRange(listing.id, "2027-01-02")).toBe(5);
  });

  test("a servicing hold on Feb 29 (leap day) and the day after rolls over correctly", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "L",
    });
    await createServicingHold({
      date: "2028-02-29",
      durationDays: 2,
      listing: { maxAttendees: 5, name: "L" },
      quantity: 3,
    });
    // [2028-02-29, 2028-03-02) covers 02-29 and 03-01 (2028 is a leap year).
    expect(await getListingRemainingForRange(listing.id, "2028-02-29")).toBe(2);
    expect(await getListingRemainingForRange(listing.id, "2028-03-01")).toBe(2);
    // 03-02 is excluded.
    expect(await getListingRemainingForRange(listing.id, "2028-03-02")).toBe(5);
  });

  test("the admin home 'upcoming service events' includes a hold dated today (boundary inclusion)", async () => {
    // The upcoming-events filter likely uses start_at >= today. A hold dated
    // today must appear (today is "upcoming", not "past").
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "L",
    });
    const today = new Date().toISOString().slice(0, 10);
    const { id } = await createTestServicingEvent({
      bookings: [{ date: today, listingId: listing.id, quantity: 2 }],
      name: "Today Service",
    });
    const body = await renderAdminPage("/admin/");
    expect(body).toContain("Today Service");
    expect(body).toContain(`/admin/servicing/${id}`);
  });

  test("a past-dated hold is excluded from the upcoming-events list (boundary exclusion)", async () => {
    const listing = await createDailyTestListing({
      maxAttendees: 5,
      name: "L",
    });
    await createTestServicingEvent({
      bookings: [{ date: "2000-01-01", listingId: listing.id, quantity: 2 }],
      name: "Ancient Service",
    });
    const body = await renderAdminPage("/admin/");
    expect(body).not.toContain("Ancient Service");
  });
});
