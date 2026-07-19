import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > getAttendeeOrNull", { db: true }, () => {
  test("returns null for missing attendee", async () => {
    const privateKey = await getTestPrivateKey();
    const attendee = await getAttendeeOrNull(999, privateKey);
    expect(attendee).toBeNull();
  });

  test("returns attendee by id", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const created = await createTestAttendee(
      listing.id,
      listing.slug,
      "John Doe",
      "john@example.com",
    );
    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendeeOrNull(created.id, privateKey);

    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("John Doe");
  });
});
