import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { resolveEntries } from "#routes/tickets/token-utils.ts";
import { getAttendeesByTokens } from "#shared/db/attendees/tokens.ts";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("ticket token utils > resolveEntries", { db: true }, () => {
  test("skips listings when attendee bookings array is empty", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "No booking",
      "nobooking@example.com",
    );

    await getDb().execute({
      args: [attendee.id],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });

    const attendees = await getAttendeesByTokens([token]);
    const entries = await resolveEntries([attendees[0]!]);
    expect(entries).toEqual([]);
  });
});
