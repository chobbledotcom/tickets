/** The scan API's digest read: a queued check-in replaying after an outage
 * names its person by the ticket token's SHA-256, because the device never
 * held the token itself. The digest resolves inside the door's own scope
 * only, and the answers are the ones the live scan answers. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sha256Hex } from "#crypto/sha256.ts";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createMultiBookingAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";

/** A party of three on one ticket at the door's first listing: a delivery
 * admits one place, and the other two still wait. */
const partyOfThree = async () => {
  const door = await groupDoor(1);
  const attendee = await bookTestAttendee(
    [{ listingId: door.members[0]!.id, quantity: 3 }],
    "Cara",
    "cara@example.com",
  );
  return { attendee, door };
};

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

describeWithEnv(
  "a queued delivery that names its operation",
  { db: true },
  () => {
    test("a lost answer's retry admits one place of a party, once", async () => {
      // A party of three on one ticket. The device delivered one place, the
      // answer was lost on the way home, and the queue sent the same
      // delivery again. The second send must land nowhere: the first one
      // already took a place.
      const { door, attendee } = await partyOfThree();
      const body = {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b01",
        quantity: 1,
        token_hash: await sha256Hex(attendee.ticket_token),
      };

      const first = await scanAtDoor(door.group.id, body);
      expect(first.json.status).toBe("checked_in");
      expect(first.json.quantity).toBe(1);
      expect(first.json.remaining).toBe(2);

      const retry = await scanAtDoor(door.group.id, body);
      expect(retry.json.status).toBe("already_checked_in");
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 1 }]);
    });

    test("a lost answer's retry of a two-tier ticket admits no second tier", async () => {
      const door = await groupDoor(2, {}, ["Standard", "Society"]);
      const attendee = await createMultiBookingAttendee(
        "Nia",
        "nia@example.com",
        [
          { listingId: door.members[0]!.id },
          { listingId: door.members[1]!.id },
        ],
      );
      const body = {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b02",
        token_hash: await sha256Hex(attendee.ticket_token),
      };

      const first = await scanAtDoor(door.group.id, body);
      expect(first.json.status).toBe("checked_in");

      const retry = await scanAtDoor(door.group.id, body);
      expect(retry.json.status).toBe("already_checked_in");
      // The first tier is in once, and the second tier still waits.
      expect(
        (await storedCheckinRows(attendee.id)).sort(
          (a, b) => b.checked_in - a.checked_in,
        ),
      ).toEqual([{ checked_in: 1 }, { checked_in: 0 }]);
    });

    test("a fresh delivery of the same ticket still admits the next place", async () => {
      // The guard guards one delivery, not the ticket: the party's next
      // arrival is a new delivery with an id of its own, and it gets in.
      const { door, attendee } = await partyOfThree();
      const tokenHash = await sha256Hex(attendee.ticket_token);

      const first = await scanAtDoor(door.group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b03",
        quantity: 1,
        token_hash: tokenHash,
      });
      expect(first.json.status).toBe("checked_in");

      const second = await scanAtDoor(door.group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b04",
        quantity: 1,
        token_hash: tokenHash,
      });
      expect(second.json.status).toBe("checked_in");
      expect(second.json.quantity).toBe(1);
      expect(second.json.remaining).toBe(1);
    });

    test("a delivery that names no real operation is refused", async () => {
      const door = await groupDoor(1);
      const attendee = await bookTestAttendee(
        [door.members[0]!.id],
        "Pia",
        "pia@example.com",
      );
      const tokenHash = await sha256Hex(attendee.ticket_token);

      for (const body of [
        { operation_id: "", token_hash: tokenHash },
        { operation_id: 7, token_hash: tokenHash },
        // A live scan reads the ticket itself, so it names no delivery.
        {
          operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b05",
          token: attendee.ticket_token,
        },
      ]) {
        const answer = await scanAtDoor(door.group.id, body);
        expect(answer.response.status).toBe(400);
        expect(answer.json.error).toBe("Invalid operation");
      }
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
    });
  },
);
