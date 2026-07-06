import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  incrementAttachmentDownloads,
  updateAttendeePII,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  createTestAttendee,
  createTestAttendeeDirect,
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

describeWithEnv(
  "db > attendees > incrementAttachmentDownloads",
  { db: true },
  () => {
    /** The stored download counter for one (attendee, listing) booking row. */
    const downloadsFor = async (
      attendeeId: number,
      listingId: number,
    ): Promise<number> => {
      const row = await queryOne<{ attachment_downloads: number }>(
        "SELECT attachment_downloads FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
        [attendeeId, listingId],
      );
      return row!.attachment_downloads;
    };

    test("adds 1 per call for the matching pair, leaving other rows alone", async () => {
      const listingA = await createTestListing({ maxAttendees: 10 });
      const listingB = await createTestListing({ maxAttendees: 10 });
      const { attendee: onA } = await createTestAttendeeDirect(
        listingA.id,
        "Downloader",
        "down@example.com",
      );
      const { attendee: onB } = await createTestAttendeeDirect(
        listingB.id,
        "Bystander",
        "by@example.com",
      );

      await incrementAttachmentDownloads(onA.id, listingA.id);
      await incrementAttachmentDownloads(onA.id, listingA.id);

      expect(await downloadsFor(onA.id, listingA.id)).toBe(2);
      // The other attendee's booking row is untouched.
      expect(await downloadsFor(onB.id, listingB.id)).toBe(0);
    });

    test("a mismatched attendee+listing pair matches no row", async () => {
      const listingA = await createTestListing({ maxAttendees: 10 });
      const listingB = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listingA.id,
        "Only A",
        "onlya@example.com",
      );

      // The attendee booked A, not B — both conditions must match one row.
      await incrementAttachmentDownloads(attendee.id, listingB.id);

      expect(await downloadsFor(attendee.id, listingA.id)).toBe(0);
    });
  },
);

describeWithEnv("db > attendees > updateAttendeePII", { db: true }, () => {
  test("rewrites the stored PII blob for that attendee only", async () => {
    const listingA = await createTestListing({ maxAttendees: 10 });
    const listingB = await createTestListing({ maxAttendees: 10 });
    const { attendee: edited } = await createTestAttendeeDirect(
      listingA.id,
      "Old Name",
      "old@example.com",
    );
    const { attendee: other } = await createTestAttendeeDirect(
      listingB.id,
      "Untouched",
      "same@example.com",
    );

    await updateAttendeePII(edited.id, {
      address: "1 New Street",
      email: "new@example.com",
      lat: "",
      lng: "",
      name: "New Name",
      payment_id: edited.payment_id,
      phone: "+447700900999",
      special_instructions: "gluten free",
      ticket_token: edited.ticket_token,
    });

    const reread = await decryptFirstAttendee(listingA.id);
    expect(reread.name).toBe("New Name");
    expect(reread.email).toBe("new@example.com");
    expect(reread.phone).toBe("+447700900999");
    expect(reread.address).toBe("1 New Street");
    expect(reread.special_instructions).toBe("gluten free");
    // Identity fields carried through the rebuilt blob are preserved.
    expect(reread.ticket_token).toBe(edited.ticket_token);

    // The write is keyed on the attendee id: the other attendee is untouched.
    const bystander = await decryptFirstAttendee(listingB.id);
    expect(bystander.name).toBe("Untouched");
    expect(bystander.email).toBe("same@example.com");
    expect(bystander.id).toBe(other.id);
  });
});
