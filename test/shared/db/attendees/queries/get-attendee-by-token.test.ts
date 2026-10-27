import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeeRawByToken } from "#db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > getAttendeeRawByToken", { db: true }, () => {
  test("returns the raw row a stored token indexes, and null for an unknown one", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "by-token@example.com",
      name: "By Token",
      ticketToken: "lookup-token-1",
    });
    if (!made.success) throw new Error("booking setup failed");

    const row = await getAttendeeRawByToken("lookup-token-1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(made.attendees[0]!.id);
    // The read is raw: the sealed blob still holds the ciphertext.
    expect(row!.pii_blob).not.toContain("By Token");

    expect(await getAttendeeRawByToken("no-such-token")).toBeNull();
  });
});
