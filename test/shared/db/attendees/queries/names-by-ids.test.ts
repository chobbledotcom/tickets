import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeNamesByIds } from "#db/attendees/queries.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > getAttendeeNamesByIds", { db: true }, () => {
  test("getAttendeeNamesByIds decrypts the name for the given attendee id", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Grace Hopper",
      "grace@example.com",
    );

    const privateKey = await getTestPrivateKey();
    const names = await getAttendeeNamesByIds([attendee.id], privateKey);

    expect(names.get(attendee.id)).toBe("Grace Hopper");
  });

  test("getAttendeeNamesByIds returns an empty map for no ids", async () => {
    const privateKey = await getTestPrivateKey();
    const names = await getAttendeeNamesByIds([], privateKey);
    expect(names.size).toBe(0);
  });
});
