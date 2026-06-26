import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  decryptAttendees,
  getAttendeesRaw,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
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

  const decryptFirstAttendee = async (listingId: number) => {
    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(listingId);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(1);
    return attendees[0]!;
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
