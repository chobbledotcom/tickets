import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getNewestAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createMultiBookingAttendee,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > getNewestAttendeesRaw", { db: true }, () => {
  test("returns attendees across listings ordered by newest first", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });

    await createTestAttendee(
      listing1.id,
      listing1.slug,
      "First",
      "first@example.com",
    );
    await createTestAttendee(
      listing2.id,
      listing2.slug,
      "Second",
      "second@example.com",
    );
    await createTestAttendee(
      listing1.id,
      listing1.slug,
      "Third",
      "third@example.com",
    );

    const privateKey = await getTestPrivateKey();
    const raw = await getNewestAttendeesRaw(10);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(3);
    // Newest first
    expect(attendees[0]?.name).toBe("Third");
  });

  test("respects limit", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    for (let i = 0; i < 3; i++) {
      await createTestAttendee(
        listing.id,
        listing.slug,
        `Name${i}`,
        `n${i}@example.com`,
      );
    }

    const raw = await getNewestAttendeesRaw(2);
    expect(raw.length).toBe(2);
  });

  test("counts the limit in attendees and returns each one's every booking line", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });
    await createTestAttendee(
      listing1.id,
      listing1.slug,
      "Old",
      "old@example.com",
    );
    const multi = await createMultiBookingAttendee(
      "Newest",
      "new@example.com",
      [{ listingId: listing1.id }, { listingId: listing2.id }],
    );

    // Limit 1 = the newest attendee — BOTH of their lines, nothing of "Old".
    const raw = await getNewestAttendeesRaw(1);
    expect(raw.map((row) => row.id)).toEqual([multi.id, multi.id]);
    expect(raw.map((row) => row.listing_id).toSorted()).toEqual(
      [listing1.id, listing2.id].toSorted(),
    );
  });

  test("returns empty array when no attendees", async () => {
    const raw = await getNewestAttendeesRaw(10);
    expect(raw).toEqual([]);
  });
});
