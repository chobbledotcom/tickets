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
import { settings } from "#db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { orphanAttendeeBooking } from "#test-utils/db-fault.ts";
import {
  bookTestAttendee,
  createMultiBookingAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundThroughLedger } from "#test-utils/ledger.ts";
import { insertSecondBookingRow } from "#test-utils/logistics.ts";

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

  test("a manual pick admits by attendee id, with no ticket token in the request", async () => {
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Picked Person",
      "picked@example.com",
    );

    const answer = await scanAtDoor(door.group.id, {
      attendee_id: attendee.id,
    });

    expect(answer.json.status).toBe("checked_in");
    expect(answer.json.name).toBe("Picked Person");
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 1 }]);
  });

  test("a manual pick for a person on another door's listings answers not_found and names nobody", async () => {
    const door = await groupDoor(1);
    const otherDoor = await groupDoor(1, {}, ["Stranger hall"], "Other doors");
    const stranger = await bookTestAttendee(
      [otherDoor.members[0]!.id],
      "Stranger Person",
      "stranger@example.com",
    );

    const answer = await scanAtDoor(door.group.id, {
      attendee_id: stranger.id,
    });

    expect(answer.response.status).toBe(404);
    expect(answer.json.status).toBe("not_found");
    expect(answer.json.name).toBeUndefined();
    expect(await storedCheckinRows(stranger.id)).toEqual([{ checked_in: 0 }]);
  });

  test("an orphaned ticket line answers wrong_listing, naming its person", async () => {
    const door = await groupDoor(2);
    const token = await orphanedTokenFrom(door.members[0]!.id);

    const answer = await scanAtDoor(door.group.id, { token });

    // The line points at a listing that no longer resolves, so the ticket
    // matches no door. A camera read may name the person it decoded — the
    // guest presented the credential.
    expect(answer.response.status).toBe(200);
    expect(answer.json.status).toBe("wrong_listing");
    expect(answer.json.name).toBe("Owen");
  });

  test("a forced scan of an orphaned ticket line answers not_found", async () => {
    const door = await groupDoor();
    const token = await orphanedTokenFrom(door.members[0]!.id);

    const answer = await scanAtDoor(door.group.id, { force: true, token });

    expect(answer.response.status).toBe(404);
    expect(answer.json.status).toBe("not_found");
  });

  test("a ticket with only no-check-in rows never admits, forceably too", async () => {
    // A group whose only member sells with no door: its scope holds no
    // listing, and the attendee's one row sits on exactly that listing.
    const { group, members } = await groupDoor(1);
    const { getDb } = await import("#db/client.ts");
    await getDb().execute({
      args: [1, members[0]!.id],
      sql: "UPDATE listings SET purchase_only = 1 WHERE id = ?",
    });
    const attendee = await bookTestAttendee(
      [members[0]!.id],
      "No Door Person",
      "nodoor@example.com",
    );

    for (const body of [
      { token: attendee.ticket_token },
      { force: true, token: attendee.ticket_token },
    ]) {
      const answer = await scanAtDoor(group.id, body);
      expect(answer.response.status).toBe(200);
      expect(answer.json.status).toBe("wrong_listing");
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
    }
  });

  test("a door action leaves a merged attendee's refunded order untouched", async () => {
    // One attendee, two orders on the same listing: the first is refunded
    // (the state an attendee merge supports), the second still waits.
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Merged Person",
      "merged@example.com",
    );
    await refundThroughLedger(attendee.id, door.members[0]!.id);
    await insertSecondBookingRow(
      attendee.id,
      door.members[0]!.id,
      todayInTz(settings.timezone),
    );

    const answer = await scanAtDoor(door.group.id, {
      token: attendee.ticket_token,
    });
    expect(answer.json.status).toBe("checked_in");

    // The live order checked in; the refunded order kept its state.
    const rows = await storedCheckinRows(attendee.id);
    expect([...rows].sort((a, b) => b.checked_in - a.checked_in)).toEqual([
      { checked_in: 1 },
      { checked_in: 0 },
    ]);
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
