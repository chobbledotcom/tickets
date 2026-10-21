/** The scan API's digest read: a queued check-in replaying after an outage
 * names its person by the ticket token's keyed digest, because the device
 * never held the token itself. The digest resolves inside the door's own
 * scope only, and the answers are the ones the live scan answers. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { hmacHex } from "#crypto/sha256.ts";
import { doorCacheName } from "#routes/admin/scan-tokens.ts";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createMultiBookingAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import type { Attendee } from "#types";

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

/** The digest one group door's saved list holds for one token: HMAC-SHA256
 * under that door's derived cache key, the same construction the device
 * runs. */
const doorDigest = async (groupId: number, token: string): Promise<string> =>
  hmacHex(deriveDoorCacheKey(doorCacheName("group", groupId)), token);

/** One queued delivery sent twice: the body the door read on each send.
 * A lost answer's retry sends the very same request again. */
const sendTwice = async (groupId: number, body: Record<string, unknown>) => {
  const first = await scanAtDoor(groupId, body);
  const retry = await scanAtDoor(groupId, body);
  return { first, retry };
};

/** A two-tier door and a person holding one place on the first tier and
 * `secondPlaces` places on the second. */
const twoTierDoor = async (
  who: string,
  email: string,
  doorName: string,
  secondPlaces = 1,
) => {
  const door = await groupDoor(2, {}, ["Standard", "Society"], doorName);
  const attendee = await createMultiBookingAttendee(who, email, [
    { listingId: door.members[0]!.id },
    { listingId: door.members[1]!.id, quantity: secondPlaces },
  ]);
  return { attendee, door };
};

/** One queued delivery's request body: the delivery's id, the ticket's
 * keyed digest, and the optional quantity pick. */
const queuedBody = async (
  groupId: number,
  token: string,
  operationId: string,
  quantity?: number,
): Promise<Record<string, unknown>> => ({
  operation_id: operationId,
  token_hash: await doorDigest(groupId, token),
  ...(quantity === undefined ? {} : { quantity }),
});

/** A two-tier ticket's delivery, sent twice. The first send admits the
 * first tier once; the retry answers the delivery's own landing — the tier
 * the first send put in, not the tier a fresh decision would pick now —
 * and the second tier still waits for its own scan. */
const deliverTwoTier = async (
  door: Awaited<ReturnType<typeof twoTierDoor>>["door"],
  attendee: Attendee,
  operationId: string,
): Promise<void> => {
  const body = await queuedBody(
    door.group.id,
    attendee.ticket_token,
    operationId,
  );
  const { first, retry } = await sendTwice(door.group.id, body);
  expect(first.json.status).toBe("checked_in");
  expect(first.json.listingName).toBe("Standard");
  expect(retry.json.status).toBe("already_checked_in");
  expect(retry.json.listingName).toBe("Standard");
  expect(
    (await storedCheckinRows(attendee.id)).sort(
      (a, b) => b.checked_in - a.checked_in,
    ),
  ).toEqual([{ checked_in: 1 }, { checked_in: 0 }]);
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
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b10",
        token_hash: await doorDigest(door.group.id, attendee.ticket_token),
      });

      expect(answer.response.status).toBe(200);
      expect(answer.json.status).toBe("checked_in");
      expect(answer.json.name).toBe("Pia");
    });

    test("answers not_found for a digest nothing on the door holds", async () => {
      const { group } = await groupDoor(1);

      const answer = await scanAtDoor(group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b11",
        token_hash: await doorDigest(group.id, "no-token-any-attendee-holds"),
      });

      expect(answer.response.status).toBe(404);
      expect(answer.json.status).toBe("not_found");
    });

    test("never resolves a digest against another door's tickets", async () => {
      // Two doors, named apart: the digest the other door's device stored
      // must not open this door. The digest is keyed to its own door, so a
      // stolen list digests nothing at the door it was not saved for.
      const other = await groupDoor(1, {}, ["Other standard"], "Other door");
      const otherAttendee = await bookTestAttendee(
        [other.members[0]!.id],
        "Ada",
        "ada@example.com",
      );
      const door = await groupDoor(1, {}, ["Door standard"]);

      const answer = await scanAtDoor(door.group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b12",
        token_hash: await doorDigest(
          other.group.id,
          otherAttendee.ticket_token,
        ),
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
      const body = await queuedBody(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b00",
      );

      const { first, retry } = await sendTwice(door.group.id, body);
      expect(first.json.status).toBe("checked_in");

      // A second device replayed the same queued check-in: the answer this
      // device reads out to its door says the person is already in.
      expect(retry.json.status).toBe("already_checked_in");
      expect(retry.json.name).toBe("Bruno");
    });

    test("a digest delivery that names no operation is refused", async () => {
      // The digest path's only caller is the offline queue, and every
      // queued check-in names the delivery it belongs to. An unnamed
      // digest could never be guarded against a replay: a resent delivery
      // without its id would admit a second place. Failing closed keeps
      // the exactly-once promise.
      const { door, attendee } = await partyOfThree();

      const answer = await scanAtDoor(door.group.id, {
        quantity: 1,
        token_hash: await doorDigest(door.group.id, attendee.ticket_token),
      });
      expect(answer.response.status).toBe(400);
      expect(answer.json.error).toBe("Invalid operation");
      // Nothing was admitted, so a resent delivery cannot double-admit.
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
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
      const body = await queuedBody(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b01",
        1,
      );

      const first = await scanAtDoor(door.group.id, body);
      expect(first.json.status).toBe("checked_in");
      expect(first.json.quantity).toBe(1);
      expect(first.json.remaining).toBe(2);

      const retry = await scanAtDoor(door.group.id, body);
      expect(retry.json.status).toBe("already_checked_in");
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 1 }]);
    });

    test("a lost answer's retry of a two-tier ticket admits no second tier", async () => {
      const { door, attendee } = await twoTierDoor(
        "Nia",
        "nia@example.com",
        "Doors",
      );
      await deliverTwoTier(
        door,
        attendee,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b02",
      );
    });

    test("a completed delivery's retry is never answered with a fresh prompt", async () => {
      // The first tier owes one place and admits straight in; the second
      // owes three, so a fresh decision would now ask "how many?" — a
      // prompt the first send never needed. The retry must acknowledge the
      // delivery instead of asking again.
      const { door, attendee } = await twoTierDoor(
        "Ola",
        "ola@example.com",
        "Prompt",
        3,
      );
      await deliverTwoTier(
        door,
        attendee,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b03",
      );
    });

    test("an operation id reused for another ticket's digest still admits that ticket", async () => {
      // The ledger keys a delivery on its id and its digest together. A
      // device that reuses an id for a different ticket's delivery must
      // not read a false "already in" for that ticket: the pair differs,
      // so the delivery claims its own row and admits.
      const door = await groupDoor(1);
      const first = await bookTestAttendee(
        [door.members[0]!.id],
        "Pia",
        "pia@example.com",
      );
      const second = await bookTestAttendee(
        [door.members[0]!.id],
        "Quinn",
        "quinn@example.com",
      );
      const operationId = "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b04";

      const firstDelivery = await scanAtDoor(door.group.id, {
        operation_id: operationId,
        token_hash: await doorDigest(door.group.id, first.ticket_token),
      });
      expect(firstDelivery.json.status).toBe("checked_in");

      const reused = await scanAtDoor(door.group.id, {
        operation_id: operationId,
        token_hash: await doorDigest(door.group.id, second.ticket_token),
      });
      expect(reused.json.status).toBe("checked_in");
      expect(reused.json.name).toBe("Quinn");
      expect(await storedCheckinRows(first.id)).toEqual([{ checked_in: 1 }]);
      expect(await storedCheckinRows(second.id)).toEqual([{ checked_in: 1 }]);
    });

    test("a fresh delivery of the same ticket still admits the next place", async () => {
      // The guard guards one delivery, not the ticket: the party's next
      // arrival is a new delivery with an id of its own, and it gets in.
      const { door, attendee } = await partyOfThree();
      const tokenHash = await doorDigest(door.group.id, attendee.ticket_token);

      const first = await scanAtDoor(door.group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b05",
        quantity: 1,
        token_hash: tokenHash,
      });
      expect(first.json.status).toBe("checked_in");

      const second = await scanAtDoor(door.group.id, {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b06",
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
      const tokenHash = await doorDigest(door.group.id, attendee.ticket_token);

      for (const body of [
        { operation_id: "", token_hash: tokenHash },
        { operation_id: 7, token_hash: tokenHash },
        // A live scan reads the ticket itself, so it names no delivery.
        {
          operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b07",
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
