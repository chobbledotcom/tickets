import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import {
  withRejectedBookingWrite,
  withSkippedBookingWrite,
} from "#test-utils/atomic-booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeLineFields,
  expectNoAttendeesForListings,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("admin attendee create atomic failures", { db: true }, () => {
  test("rolls back the first listing when a later guarded booking cannot be written", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const full = await createTestListing({ maxAttendees: 0 });

    await withSkippedBookingWrite(full.id, async () => {
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Admin Partial Capacity",
        ...attendeeLineFields([
          { eventId: first.id, quantity: 1 },
          { eventId: full.id, quantity: 1 },
        ]),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("spots");
    });

    await expectNoAttendeesForListings([first.id, full.id]);
  });

  test("rolls back every listing and returns a server error for an unexpected database failure", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const rejected = await createTestListing({ maxAttendees: 5 });

    await withRejectedBookingWrite(rejected.id, async () => {
      await expect(
        adminFormPost("/admin/attendees/new", {
          name: "Admin Atomic",
          ...attendeeLineFields([
            { eventId: first.id, quantity: 1 },
            { eventId: rejected.id, quantity: 1 },
          ]),
        }),
      ).rejects.toThrow("unexpected booking write");
    });

    await expectNoAttendeesForListings([first.id, rejected.id]);
  });

  test("reports an encryption failure instead of calling it a capacity error", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const encryptionFailure = stub(attendeesApi, "createAttendeeAtomic", () =>
      Promise.resolve({ reason: "encryption_error" as const, success: false }),
    );
    try {
      await expect(
        adminFormPost("/admin/attendees/new", {
          name: "Admin Encryption Failure",
          ...attendeeLineFields([{ eventId: listing.id, quantity: 1 }]),
        }),
      ).rejects.toThrow("Could not encrypt the new attendee");
    } finally {
      encryptionFailure.restore();
    }
  });
});
