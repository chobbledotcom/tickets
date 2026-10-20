/** The scan API's digest read: a queued check-in replaying after an outage
 * names its person by the ticket token's SHA-256, because the device never
 * held the token itself. The digest resolves inside the door's own scope
 * only, and the answers are the ones the live scan answers. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sha256Hex } from "#crypto/sha256.ts";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";

describeWithEnv(
  "a queued check-in replaying by token digest",
  { db: true },
  () => {
    test("admits the ticket the digest belongs to", async () => {
      const door = await groupDoor(1);
      const attendee = await bookTestAttendee(
        [door.members[0]!.id],
        "Pia",
        "pia@example.com",
      );

      const answer = await scanAtDoor(door.group.id, {
        token_hash: await sha256Hex(attendee.ticket_token),
      });

      expect(answer.response.status).toBe(200);
      expect(answer.json.status).toBe("checked_in");
      expect(answer.json.name).toBe("Pia");
    });

    test("answers not_found for a digest nothing on the door holds", async () => {
      const { group } = await groupDoor(1);

      const answer = await scanAtDoor(group.id, {
        token_hash: await sha256Hex("no-token-any-attendee-holds"),
      });

      expect(answer.response.status).toBe(404);
      expect(answer.json.status).toBe("not_found");
    });

    test("never resolves a digest against another door's tickets", async () => {
      // Two doors, named apart: the digest the other door's device stored
      // must not open this door.
      const other = await groupDoor(1, {}, ["Other standard"], "Other door");
      const otherAttendee = await bookTestAttendee(
        [other.members[0]!.id],
        "Ada",
        "ada@example.com",
      );
      const door = await groupDoor(1, {}, ["Door standard"]);

      const answer = await scanAtDoor(door.group.id, {
        token_hash: await sha256Hex(otherAttendee.ticket_token),
      });

      expect(answer.response.status).toBe(404);
      expect(answer.json.status).toBe("not_found");
    });

    test("a replayed digest the door already took answers already_checked_in, naming the person", async () => {
      const door = await groupDoor(1);
      const attendee = await bookTestAttendee(
        [door.members[0]!.id],
        "Bruno",
        "bruno@example.com",
      );
      const body = { token_hash: await sha256Hex(attendee.ticket_token) };

      const first = await scanAtDoor(door.group.id, body);
      expect(first.json.status).toBe("checked_in");

      // A second device replayed the same queued check-in: the answer this
      // device reads out to its door says the person is already in.
      const second = await scanAtDoor(door.group.id, body);
      expect(second.json.status).toBe("already_checked_in");
      expect(second.json.name).toBe("Bruno");
    });
  },
);
