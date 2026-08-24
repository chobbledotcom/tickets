import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > creation work", { db: true }, () => {
  test("passes the stored attendee id to creation work", async () => {
    const listing = await createTestListing({ maxAttendees: 1 });
    let workAttendeeId = 0;

    const result = await createAttendeeAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "work@example.com",
        name: "Creation work",
      },
      (_tx, attendeeId) => {
        workAttendeeId = attendeeId;
        return Promise.resolve();
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(workAttendeeId).toBe(result.attendees[0]!.id);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
  });

  test("skips creation work when a booking does not insert", async () => {
    const listing = await createTestListing({ maxAttendees: 0 });
    let workRan = false;

    const result = await createAttendeeAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "full@example.com",
        name: "Full",
      },
      () => {
        workRan = true;
        return Promise.resolve();
      },
    );

    // The refusal names the full listing.
    expect(result).toEqual({
      listingIds: [listing.id],
      reason: "capacity_exceeded",
      success: false,
    });
    expect(workRan).toBe(false);
    expect(await getAttendeesRaw(listing.id)).toEqual([]);
  });
});
