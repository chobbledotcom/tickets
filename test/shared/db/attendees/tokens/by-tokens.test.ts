import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { getDb } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > attendees > getAttendeesByTokens", { db: true }, () => {
  test("returns an empty list for no tokens", async () => {
    expect(await getAttendeesByTokens([])).toEqual([]);
  });

  test("returns attendees in token order", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });

    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
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
    // The plaintext token is a placeholder here: the caller already holds the
    // input tokens (this function returns them in the same order), so it fills
    // them in. Lock the placeholder so a mutant that seeds a non-empty string
    // is caught.
    expect(results[0]?.ticket_token).toBe("");
    expect(results[1]?.ticket_token).toBe("");
  });

  test("returns null for missing tokens", async () => {
    const results = await getAttendeesByTokens(["nonexistent"]);
    expect(results.length).toBe(1);
    expect(results[0]).toBeNull();
  });

  test("returns empty bookings for orphaned attendee", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { createTestAttendeeDirect: createDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
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
