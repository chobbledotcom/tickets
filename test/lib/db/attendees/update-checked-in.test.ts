import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { updateCheckedIn } from "#shared/db/attendees.ts";
import {
  createTestAttendee,
  createTestListing,
  decryptFirstAttendee,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > updateCheckedIn", { db: true }, () => {
  const createAttendeeWithUpdates = async (updates: boolean[]) => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Check User",
      "check@example.com",
    );
    for (const checked of updates) {
      await updateCheckedIn(attendee.id, listing.id, checked);
    }
    return listing;
  };

  const expectFirstAttendeeCheckedIn = async (
    listingId: number,
    expected: boolean,
  ) => {
    const attendee = await decryptFirstAttendee(listingId);
    expect(attendee.checked_in).toBe(expected);
  };

  test("updates checked_in to true for existing attendee", async () => {
    const listing = await createAttendeeWithUpdates([true]);
    await expectFirstAttendeeCheckedIn(listing.id, true);
  });

  test("updates checked_in back to false", async () => {
    const listing = await createAttendeeWithUpdates([true, false]);
    await expectFirstAttendeeCheckedIn(listing.id, false);
  });
});
