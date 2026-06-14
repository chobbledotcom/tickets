import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addListingLink, getAttendeesRaw } from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > addListingLink", { db: true }, () => {
  test("admits a multi-day link whose range contains non-overlapping bookings", async () => {
    // Per-day expansion must admit a range whose days each have room,
    // even though overlap-sum sees multiple bookings inside the window.
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(listing, { date: "2026-05-01", durationDays: 1 });
    await bookAttendee(listing, { date: "2026-05-03", durationDays: 1 });
    const base = await bookAttendee(listing, {
      date: "2026-05-20",
      durationDays: 1,
    });
    if (!base.success) throw new Error("setup failed");
    const link = await addListingLink(base.attendees[0]!.id, {
      date: "2026-05-01",
      durationDays: 3,
      listingId: listing.id,
      quantity: 1,
    });
    expect(link.success).toBe(true);
  });

  test("defaults quantity to 1 when omitted", async () => {
    const first = await createTestListing({ maxAttendees: 3 });
    const second = await createTestListing({ maxAttendees: 3 });
    const base = await bookAttendee(first);
    if (!base.success) throw new Error("setup failed");
    const link = await addListingLink(base.attendees[0]!.id, {
      listingId: second.id,
    });
    expect(link.success).toBe(true);
    const rows = await getAttendeesRaw(second.id);
    expect(Number(rows[0]!.quantity)).toBe(1);
  });
});
