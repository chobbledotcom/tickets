import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { withRejectedBookingWrite } from "#test-utils/atomic-booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestServicingEvent,
  expectRejects,
} from "#test-utils/servicing.ts";

describeWithEnv("servicing create atomic failures", { db: true }, () => {
  test("rolls back an available hold when a later listing has no capacity", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const full = await createTestListing({ maxAttendees: 0 });

    await expectRejects(
      createTestServicingEvent({
        bookings: [
          { listingId: first.id, quantity: 1 },
          { listingId: full.id, quantity: 1 },
        ],
        name: "Servicing Partial Capacity",
      }),
      /spots/,
    );

    expect(await getAttendeesRaw(first.id)).toEqual([]);
    expect(await getAttendeesRaw(full.id)).toEqual([]);
  });

  test("rolls back every hold and propagates an unexpected database error", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const rejected = await createTestListing({ maxAttendees: 5 });

    await withRejectedBookingWrite(rejected.id, async () => {
      await expectRejects(
        createTestServicingEvent({
          bookings: [
            { listingId: first.id, quantity: 1 },
            { listingId: rejected.id, quantity: 1 },
          ],
          name: "Servicing Atomic",
        }),
        /unexpected booking write/,
      );
    });

    expect(await getAttendeesRaw(first.id)).toEqual([]);
    expect(await getAttendeesRaw(rejected.id)).toEqual([]);
  });
});
