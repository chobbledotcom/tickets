import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesByTokens } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

describeWithEnv("db > attendees > getAttendeesByTokens", { db: true }, () => {
  test("returns attendees in token order", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    const { createTestAttendeeDirect } = await import("#test-utils");
    const { attendee: a1, token: token1 } = await createTestAttendeeDirect(
      listing.id,
      "Tok1",
      "tok1@example.com",
    );
    const { attendee: a2, token: token2 } = await createTestAttendeeDirect(
      listing.id,
      "Tok2",
      "tok2@example.com",
    );

    const results = await getAttendeesByTokens([token2, token1]);
    expect(results.length).toBe(2);
    expect(results[0]?.id).toBe(a2.id);
    expect(results[1]?.id).toBe(a1.id);
  });

  test("returns null for missing tokens", async () => {
    const results = await getAttendeesByTokens(["nonexistent"]);
    expect(results.length).toBe(1);
    expect(results[0]).toBeNull();
  });

  test("returns empty bookings for orphaned attendee", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { createTestAttendeeDirect: createDirect } = await import(
      "#test-utils"
    );
    const { attendee, token } = await createDirect(
      listing.id,
      "Orphan",
      "orphan@test.com",
    );
    await getDb().execute({
      args: [attendee.id],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });
    const results = await getAttendeesByTokens([token]);
    expect(results[0]).not.toBeNull();
    expect(results[0]!.bookings).toEqual([]);
  });
});
