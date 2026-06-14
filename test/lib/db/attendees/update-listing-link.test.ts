import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > updateListingLink", { db: true }, () => {
  test("updates quantity with capacity guard", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createTestListing({ maxAttendees: 5 });
    const result = await bookAttendee(listing, { quantity: 2 });
    if (!result.success) throw new Error("setup");
    const update = await updateListingLink(
      result.attendees[0]!.id,
      listing.id,
      {
        date: null,
        quantity: 3,
      },
    );
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(3);
  });

  test("rejects update that would exceed capacity", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createTestListing({ maxAttendees: 3 });
    const result = await bookAttendee(listing, { quantity: 2 });
    if (!result.success) throw new Error("setup");
    const update = await updateListingLink(
      result.attendees[0]!.id,
      listing.id,
      {
        date: null,
        quantity: 4,
      },
    );
    expect(update.success).toBe(false);
  });

  test("updates date for daily listing link", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createDailyTestListing({ maxAttendees: 10 });
    const result = await bookAttendee(listing, { date: "2026-04-07" });
    if (!result.success) throw new Error("setup");
    const update = await updateListingLink(
      result.attendees[0]!.id,
      listing.id,
      {
        date: "2026-04-08",
        quantity: 1,
      },
    );
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(listing.id))[0]!.date).toBe("2026-04-08");
  });

  test("admits a multi-day update whose range contains non-overlapping bookings", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
    });
    await bookAttendee(listing, { date: "2026-06-01", durationDays: 1 });
    await bookAttendee(listing, { date: "2026-06-03", durationDays: 1 });
    const target = await bookAttendee(listing, {
      date: "2026-06-20",
      durationDays: 1,
    });
    if (!target.success) throw new Error("setup");
    const moved = await updateListingLink(target.attendees[0]!.id, listing.id, {
      date: "2026-06-01",
      durationDays: 3,
      quantity: 1,
    });
    expect(moved.success).toBe(true);
  });

  test("returns capacity_exceeded for non-existent (attendee, listing) pair", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createTestListing({ maxAttendees: 5 });
    expect(
      (
        await updateListingLink(999_999, listing.id, {
          date: null,
          quantity: 1,
        })
      ).success,
    ).toBe(false);
  });

  test("self-excludes a multi-day booking when moving it to an overlapping range", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 1,
    });
    // Own booking occupies days 1-3. Move it to days 2-4 — days 2-3
    // overlap, but the self-exclusion must subtract the old row so the
    // per-day count doesn't exceed cap.
    const own = await bookAttendee(listing, {
      date: "2026-08-01",
      durationDays: 3,
      quantity: 1,
    });
    if (!own.success) throw new Error("setup");
    const moved = await updateListingLink(own.attendees[0]!.id, listing.id, {
      date: "2026-08-02",
      durationDays: 3,
      quantity: 1,
    });
    expect(moved.success).toBe(true);
  });

  test("self-excludes on a group-capped daily listing", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 2 });
    const listing = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 5,
    });
    const own = await bookAttendee(listing, {
      date: "2026-07-01",
      quantity: 2,
    });
    if (!own.success) throw new Error("setup");
    const moved = await updateListingLink(own.attendees[0]!.id, listing.id, {
      date: "2026-07-02",
      durationDays: 1,
      quantity: 2,
    });
    expect(moved.success).toBe(true);
  });

  test("self-excludes on a group-capped standard listing", async () => {
    const { updateListingLink } = await import("#shared/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 3 });
    const listing = await createTestListing({
      groupId: group.id,
      listingType: "standard",
      maxAttendees: 10,
    });
    const own = await bookAttendee(listing, { quantity: 2 });
    if (!own.success) throw new Error("setup");
    const resized = await updateListingLink(own.attendees[0]!.id, listing.id, {
      date: null,
      quantity: 3,
    });
    expect(resized.success).toBe(true);
  });
});
