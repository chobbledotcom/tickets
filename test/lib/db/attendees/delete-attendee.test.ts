import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee, getAttendee } from "#shared/db/attendees.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > deleteAttendee", { db: true }, () => {
  test("removes attendee", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "John Doe",
      "john@example.com",
    );

    await deleteAttendee(attendee.id);

    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendee(attendee.id, privateKey);
    expect(fetched).toBeNull();
  });

  test("removes processed payment records", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Jane Doe",
      "jane@example.com",
    );

    await reserveSession("sess_attendee_delete");
    await finalizePaymentSession("sess_attendee_delete", attendee.id);

    await deleteAttendee(attendee.id);

    const processed = await isSessionProcessed("sess_attendee_delete");
    expect(processed).toBeNull();
  });
});
