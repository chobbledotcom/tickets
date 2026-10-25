/** Shared fixtures for the scan-answer suites: one door with a party on a
 * ticket, the digest a queued delivery names its person by, and the exact
 * request a delivery sends. */

import { expect } from "@std/expect";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { doorCacheName } from "#routes/admin/scan-cache.ts";
import { hmacHex } from "#shared/sha256.ts";
import { groupDoor, scanAtDoor } from "#test/features/admin/scanner/support.ts";
import {
  bookTestAttendee,
  createMultiBookingAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import type { Attendee } from "#types";

/** A party of three on one ticket at the door's first listing: a delivery
 * admits one place, and the other two still wait. */
export const partyOfThree = async () => {
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
export const doorDigest = async (
  groupId: number,
  token: string,
): Promise<string> =>
  hmacHex(deriveDoorCacheKey(doorCacheName("group", groupId)), token);

/** One queued delivery sent twice: the body the door read on each send.
 * A lost answer's retry sends the very same request again. */
export const sendTwice = async (
  groupId: number,
  body: Record<string, unknown>,
) => {
  const first = await scanAtDoor(groupId, body);
  const retry = await scanAtDoor(groupId, body);
  return { first, retry };
};

/** One landed delivery's retry: the first send admits, the retry answers
 * the delivery's own landing. Answers both bodies for the caller's own
 * quantity and listing asserts. */
export const sendTwiceLanding = async (
  groupId: number,
  body: Record<string, unknown>,
) => {
  const { first, retry } = await sendTwice(groupId, body);
  expect(first.json.status).toBe("checked_in");
  expect(retry.json.status).toBe("already_checked_in");
  return { first, retry };
};

/** One queued delivery of one ticket's keyed digest, named by its own
 * operation id and optional quantity pick, sent to the door. */
export const deliverDigest = async (
  groupId: number,
  token: string,
  operationId: string,
  quantity?: number,
) =>
  scanAtDoor(groupId, await queuedBody(groupId, token, operationId, quantity));

/** A two-tier door and a person holding one place on the first tier and
 * `secondPlaces` places on the second. */
export const twoTierDoor = async (
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
export const queuedBody = async (
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
 * first tier once. The retry answers the delivery's own landing — the tier
 * the first send put in, not the tier a fresh decision would pick now —
 * and the second tier still waits for its own scan. */
export const deliverTwoTier = async (
  door: Awaited<ReturnType<typeof twoTierDoor>>["door"],
  attendee: Attendee,
  operationId: string,
): Promise<void> => {
  const body = await queuedBody(
    door.group.id,
    attendee.ticket_token,
    operationId,
  );
  const { first, retry } = await sendTwiceLanding(door.group.id, body);
  expect(first.json.listingName).toBe("Standard");
  expect(retry.json.listingName).toBe("Standard");
  expect(
    (await storedCheckinRows(attendee.id)).sort(
      (a, b) => b.checked_in - a.checked_in,
    ),
  ).toEqual([{ checked_in: 1 }, { checked_in: 0 }]);
};
