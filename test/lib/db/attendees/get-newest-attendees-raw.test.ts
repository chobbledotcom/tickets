import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  decryptAttendees,
  getNewestAttendeesRaw,
} from "#shared/db/attendees.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

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

  test("returns empty array when no attendees", async () => {
    const raw = await getNewestAttendeesRaw(10);
    expect(raw).toEqual([]);
  });
});
