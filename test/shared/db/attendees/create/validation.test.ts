import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";
import { queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { requireAttendee } from "#test-utils/db-helpers/attendee-creation.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const CAPACITY_FAILURE = { reason: "capacity_exceeded", success: false };

describeWithEnv("db > attendees > create validation", { db: true }, () => {
  test("rejects an empty booking list", async () => {
    expect(
      await createAttendeeAtomic({ bookings: [], email: "", name: "Empty" }),
    ).toEqual(CAPACITY_FAILURE);
  });

  test("rejects a negative quantity", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    expect(
      await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: -1 }],
        email: "",
        name: "Negative",
      }),
    ).toEqual(CAPACITY_FAILURE);
  });

  test("rejects duplicate booking slots", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    expect(
      await createAttendeeAtomic({
        bookings: [
          { listingId: listing.id, quantity: 1 },
          { listingId: listing.id, quantity: 1 },
        ],
        email: "",
        name: "Duplicate",
      }),
    ).toEqual(CAPACITY_FAILURE);
  });

  test("stores zero quantity without contact activity", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "zero@example.com",
      name: "Zero",
    });

    expect(requireAttendee(result).quantity).toBe(0);
    expect(
      await queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM contact_preferences",
      ),
    ).toEqual({ count: 0 });
  });
});
