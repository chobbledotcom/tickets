/** The queued delivery's identity and digest match, direct: the request
 * parser refuses an unnamed digest, and the keyed digest resolves only
 * against the door that saved it. The scan answer's routes stand on these
 * two, so their shapes are pinned here without a route around them. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { hmacHex } from "#crypto/sha256.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { doorAttendees } from "#routes/admin/scan-answer.ts";
import {
  attendeeByTokenHash,
  deliveredListingIds,
  type QueuedDelivery,
  queuedDelivery,
} from "#routes/admin/scan-delivery.ts";
import { claimScanOperation } from "#db/processed-scan-operations.ts";
import { getRequestPrivateKey } from "#shared/session-private-key.ts";
import { groupDoor } from "#test/features/admin/scanner/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { withTestSession } from "#test-utils/session.ts";

/** The digest one door's key makes of one token, the construction the
 * device runs. */
const doorDigest = (door: string, token: string): Promise<string> =>
  hmacHex(deriveDoorCacheKey(door), token);

/** The test session's private key, or a loud failure. */
const privateKey = async (): Promise<CryptoKey> => {
  const key = await withTestSession(getRequestPrivateKey);
  if (!key) throw new Error("the test session derived no private key");
  return key;
};

/** What the door's own digest match answers for one token, digested under
 * `digestDoor`'s cache key. */
const resolveFor = async (
  door: Awaited<ReturnType<typeof groupDoor>>,
  token: string,
  digestDoor: string,
): Promise<AttendeeWithBookings | null> =>
  attendeeByTokenHash(
    await doorDigest(digestDoor, token),
    await doorAttendees([...door.members.map((m) => m.id)], await privateKey()),
    `group:${door.group.id}`,
  );

/** The refusal the parser answers: the 400 body the door reads. */
const refusalBody = async (
  refused: QueuedDelivery | Response | undefined,
): Promise<Record<string, unknown>> => {
  expect(refused instanceof Response).toBe(true);
  expect((refused as Response).status).toBe(400);
  return (await (refused as Response).json()) as Record<string, unknown>;
};

describeWithEnv("the queued delivery's identity", { db: true }, () => {
  test("answers the id and digest pair the body names", () => {
    expect(
      queuedDelivery({ operation_id: "op-1", token_hash: "digest-a" }),
    ).toEqual({ operationId: "op-1", tokenHash: "digest-a" });
  });

  test("answers undefined when the body names no digest", () => {
    expect(queuedDelivery({})).toBeUndefined();
    expect(queuedDelivery({ attendee_id: 7 })).toBeUndefined();
    expect(
      queuedDelivery({ operation_id: "op-1", token_hash: 7 }),
    ).toBeUndefined();
  });

  test("refuses a digest that names no operation", async () => {
    expect(
      await refusalBody(queuedDelivery({ token_hash: "digest-a" })),
    ).toEqual({
      error: "Invalid operation",
    });
  });

  test("refuses an operation id that is not a plain short string", async () => {
    for (const id of ["", 7, "x".repeat(101)]) {
      expect(
        await refusalBody(
          queuedDelivery({ operation_id: id, token_hash: "d" }),
        ),
      ).toEqual({ error: "Invalid operation" });
    }
  });

  test("refuses an id beside a raw token or a picked attendee id", async () => {
    for (const body of [
      { operation_id: "op-1", token: "raw-token" },
      { attendee_id: 7, operation_id: "op-1" },
    ]) {
      expect(await refusalBody(queuedDelivery(body))).toEqual({
        error: "Invalid operation",
      });
    }
  });
});

describeWithEnv("the keyed digest match", { db: true }, () => {
  test("resolves the attendee the digest belongs to", async () => {
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Pia",
      "pia@example.com",
    );
    const resolved = await resolveFor(
      door,
      attendee.ticket_token,
      `group:${door.group.id}`,
    );
    expect(resolved?.id).toBe(attendee.id);
  });

  test("answers null for a digest nothing on the door holds", async () => {
    const door = await groupDoor(1);
    expect(
      await resolveFor(door, "no-token-holds-this", `group:${door.group.id}`),
    ).toBeNull();
  });

  test("never resolves a digest keyed for another door", async () => {
    // The same token digests differently under each door's key, so a
    // digest keyed for another door opens nothing here.
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Ada",
      "ada@example.com",
    );
    expect(
      await resolveFor(door, attendee.ticket_token, "group:999999"),
    ).toBeNull();
  });

  test("fails loudly when the attendee the digest matched is gone", async () => {
    // The digest match reads the attendee the matched candidate names. The
    // door read the candidates moments ago, so the read cannot miss. A
    // miss is a broken invariant. The lookup fails loudly. It never
    // answers a stranger.
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Pia",
      "pia@example.com",
    );
    const candidates = await doorAttendees(
      [door.members[0]!.id],
      await privateKey(),
    );
    const { execute } = await import("#db/client.ts");
    await execute("DELETE FROM attendees WHERE id = ?", [attendee.id]);

    await expect(
      attendeeByTokenHash(
        await doorDigest(`group:${door.group.id}`, attendee.ticket_token),
        candidates,
        `group:${door.group.id}`,
      ),
    ).rejects.toThrow("Missing attendee for a matched ticket digest");
  });
});

describeWithEnv("the ledger row a landed delivery answers from", { db: true }, () => {
  test("answers the listings the delivery's claim stored", async () => {
    // A delivery's claim stores its pair with the listings its admission
    // moved. The retry reads those listings back, so its answer names the
    // tier the first send put in.
    const { withTransaction } = await import("#db/client.ts");
    const delivery: QueuedDelivery = {
      operationId: "op-1",
      tokenHash: "digest-a",
    };
    await withTransaction((tx) =>
      claimScanOperation({ listingIds: [3, 5], ...delivery })(tx),
    );

    expect(await deliveredListingIds(delivery)).toEqual([3, 5]);
  });

  test("throws when the ledger holds no row for the delivery", async () => {
    // The admission stores the row before any read of the answer. A miss
    // here means the row vanished, and the read fails loudly. It never
    // answers an empty tier list.
    await expect(
      deliveredListingIds({ operationId: "op-missing", tokenHash: "digest-b" }),
    ).rejects.toThrow(
      "A claimed scan delivery's ledger row went missing before its answer",
    );
  });
});
