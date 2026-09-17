/** Tests for the group scanner's answer edges, the direct suite beside the
 * routes it exercises in src/features/admin/scanner.ts:
 * POST /admin/groups/:id/scan - the same JSON check-in API over the group's
 * members
 *
 * The walk itself and its guards have their own suites beside this one;
 * this one owns the odd answers: a token nothing holds, an orphaned line,
 * and a site whose key cannot be unwrapped.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { orphanAttendeeBooking } from "#test-utils/db-fault.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { groupDoor, scanAtDoor } from "./support.ts";

/** An orphaned booking: a real token whose only line points at a listing
 * that no longer resolves, so the door's scope matches none of its rows and
 * no listing exists to name for it. */
const orphanedTokenFrom = async (listingId: number): Promise<string> => {
  const attendee = await createMultiBookingAttendee(
    "Owen",
    "owen@example.com",
    [{ listingId }],
  );
  await orphanAttendeeBooking(attendee.ticket_token);
  return attendee.ticket_token;
};

describeWithEnv("group scanner answer edges", { db: true }, () => {
  test("answers 404 with not_found for a token no attendee holds", async () => {
    const { group } = await groupDoor();

    const answer = await scanAtDoor(group.id, {
      token: "no-token-any-attendee-holds",
    });

    expect(answer.response.status).toBe(404);
    expect(answer.json.status).toBe("not_found");
  });

  test("an orphaned ticket line is queried and names no listing", async () => {
    const door = await groupDoor(2);
    const token = await orphanedTokenFrom(door.members[0]!.id);

    const answer = await scanAtDoor(door.group.id, { token });

    expect(answer.json.status).toBe("wrong_listing");
    expect(answer.json.listingName).toBe("Unknown listing");
    expect(answer.json.name).toBe("Owen");
  });

  test("a forced scan of an orphaned ticket line answers not_found", async () => {
    const door = await groupDoor();
    const token = await orphanedTokenFrom(door.members[0]!.id);

    const answer = await scanAtDoor(door.group.id, { force: true, token });

    expect(answer.response.status).toBe(404);
    expect(answer.json.status).toBe("not_found");
  });

  describe("the site's private key cannot be unwrapped", () => {
    const errorLog = setupErrorSpy();

    test("answers 500 and names the screen the failure came from", async () => {
      const door = await groupDoor();
      const ticket = await createMultiBookingAttendee(
        "Ivy",
        "ivy@example.com",
        [{ listingId: door.members[0]!.id, quantity: 1 }],
      );

      // Stash the wrapped private key away so the request's session cannot
      // unwrap it, and put it back whatever the scan answers: later suites
      // in this isolate share the settings cache.
      const { getDb } = await import("#db/client.ts");
      const { settings } = await import("#db/settings.ts");
      const stored = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'wrapped_private_key'",
      );
      const savedKey = stored.rows[0]?.value;
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'wrapped_private_key'",
      );
      settings.invalidateCache();
      try {
        const answer = await scanAtDoor(door.group.id, {
          token: ticket.ticket_token,
        });
        expect(answer.response.status).toBe(500);
        expect(answer.json.error).toBe("Decryption unavailable");
        expect(errorLog.contains("Scanner: private key unavailable")).toBe(
          true,
        );
      } finally {
        if (savedKey !== undefined) {
          await getDb().execute({
            args: [savedKey as string],
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('wrapped_private_key', ?)",
          });
        }
        settings.invalidateCache();
      }
    });
  });
});
