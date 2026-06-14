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
  test("updates checked_in to true for existing attendee", async () => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Check User",
      "check@example.com",
    );

    await updateCheckedIn(attendee.id, listing.id, true);

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(listing.id);
    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(true);
  });

  test("updates checked_in back to false", async () => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Check User",
      "check@example.com",
    );

    await updateCheckedIn(attendee.id, listing.id, true);
    await updateCheckedIn(attendee.id, listing.id, false);

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(listing.id);
    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(false);
  });
});
