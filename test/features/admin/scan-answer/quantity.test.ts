/** The scan API's quantity read: a queued check-in that names how many
 * people it admits. The door admits exactly that many on the delivery's
 * first send, a resend admits nobody and answers what the first send took,
 * and a quantity the booking cannot supply admits what is left and alerts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getNoteRows } from "#db/notes/queries.ts";
import { openNotes } from "#db/notes/sealing.ts";
import {
  deliverDigest,
  doorDigest,
  partyOfThree,
  sendTwiceLanding,
} from "#test/features/admin/scan-answer/support.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "a queued delivery that names its quantity",
  { db: true },
  () => {
    /** The once-only note the booking carries, opened up: the test asserts
     * there is exactly one and reads its words. */
    const overAdmissionNote = async (attendeeId: number): Promise<string> => {
      const notes = await openNotes(
        await getNoteRows("attendee", [attendeeId]),
        await getTestPrivateKey(),
      );
      expect(notes).toHaveLength(1);
      return notes[0]!.note;
    };

    /** The alert the door reads on both the first answer and its retry:
     * the delivery named 4, the booking held 3, and 3 got in. */
    const overAdmissionAlert = { admitted: 3, bought: 3, named: 4 };

    test("a delivery admits exactly the quantity it names", async () => {
      // A party of three. The door admits two of them on this delivery's
      // word, and the third still waits for a delivery of their own.
      const { door, attendee } = await partyOfThree();

      const first = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b20",
        2,
      );
      expect(first.json.status).toBe("checked_in");
      expect(first.json.quantity).toBe(2);
      expect(first.json.remaining).toBe(1);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 2 }]);
    });

    test("a resend of a quantity delivery admits nobody and answers the recorded quantity", async () => {
      const { door, attendee } = await partyOfThree();
      const body = {
        operation_id: "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b21",
        quantity: 2,
        token_hash: await doorDigest(door.group.id, attendee.ticket_token),
      };

      const { first, retry } = await sendTwiceLanding(door.group.id, body);
      expect(first.json.quantity).toBe(2);
      // The same delivery sent again lands nowhere, and its answer says
      // what the first send admitted — two, not the party's whole three.
      expect(retry.json.quantity).toBe(2);
      expect(retry.json.total).toBe(3);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 2 }]);
    });

    test("a quantity larger than the booking owes admits what is left and alerts", async () => {
      const { door, attendee } = await partyOfThree();

      const answer = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b22",
        4,
      );
      // Two offline devices can each name more than is left. The booking
      // supplies every place it owes — three here — and the answer says the
      // numbers, so the door alerts instead of losing the check-in.
      expect(answer.response.status).toBe(200);
      expect(answer.json.status).toBe("checked_in");
      expect(answer.json.quantity).toBe(3);
      expect(answer.json.overAdmission).toEqual(overAdmissionAlert);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 3 }]);

      // The booking's note carries the numbers once, where staff can act.
      expect(await overAdmissionNote(attendee.id)).toBe(
        "An offline door check-in named 4 people, and 3 of them could be checked in. The booking holds 3 places.",
      );

      // The delivery answered, so a resend of the same pair is a retry: it
      // admits nobody, and no second note lands.
      const retry = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b22",
        4,
      );
      expect(retry.json.status).toBe("already_checked_in");
      // The first answer named the numbers, but the door can miss it: the
      // retry is the answer the door acts on, so it says the numbers again.
      expect(retry.json.overAdmission).toEqual(overAdmissionAlert);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 3 }]);
      expect(await getNoteRows("attendee", [attendee.id])).toHaveLength(1);
    });

    test("a delivery landing on a spent booking alerts and records the attempt", async () => {
      const { door, attendee } = await partyOfThree();
      const spent = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b24",
        3,
      );
      expect(spent.json.status).toBe("checked_in");

      const answer = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b25",
        2,
      );
      expect(answer.json.status).toBe("already_checked_in");
      expect(answer.json.overAdmission).toEqual({
        admitted: 0,
        bought: 3,
        named: 2,
      });
      expect(await overAdmissionNote(attendee.id)).toBe(
        "An offline door check-in named 2 people, and none could be checked in. The booking holds 3 places.",
      );

      // A spent booking stores no delivery row, so the resend runs the
      // answer again. The named note keeps it to one record.
      const retry = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b25",
        2,
      );
      expect(retry.json.status).toBe("already_checked_in");
      expect(retry.json.overAdmission).toEqual({
        admitted: 0,
        bought: 3,
        named: 2,
      });
      expect(await getNoteRows("attendee", [attendee.id])).toHaveLength(1);
    });

    test("a quantity below one is refused for a queued delivery too", async () => {
      const { door, attendee } = await partyOfThree();

      for (const [suffix, quantity] of [
        ["4", 0],
        ["5", -1],
      ] as const) {
        const answer = await deliverDigest(
          door.group.id,
          attendee.ticket_token,
          `018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b2${suffix}`,
          quantity,
        );
        expect(answer.response.status).toBe(400);
        expect(answer.json.error).toBe("Invalid quantity");
      }
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
    });

    test("a partial delivery leaves the rest of the party for a new delivery", async () => {
      const { door, attendee } = await partyOfThree();

      const first = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b26",
        1,
      );
      expect(first.json.status).toBe("checked_in");
      expect(first.json.quantity).toBe(1);

      const second = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b27",
        2,
      );
      expect(second.json.status).toBe("checked_in");
      expect(second.json.quantity).toBe(2);
      expect(second.json.remaining).toBe(0);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 3 }]);

      // Nobody is left to admit, so a further delivery of the same ticket
      // answers that the person is already in.
      const third = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b28",
        1,
      );
      expect(third.json.status).toBe("already_checked_in");
    });

    test("a quantity delivery across a two-listing ticket admits exactly its quantity", async () => {
      // A group door that checks every listing in. The ticket holds four
      // places at the first listing and two at the second; a delivery that
      // names five admits four and one, never more.
      const group = await createTestGroup({
        name: "Quantity Hall",
        scanChecksInAllListings: true,
      });
      const standard = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: `Quantity Standard ${group.id}`,
      });
      const society = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: `Quantity Society ${group.id}`,
      });
      const attendee = await createMultiBookingAttendee(
        "Tess",
        "tess@example.com",
        [
          { listingId: standard.id, quantity: 4 },
          { listingId: society.id, quantity: 2 },
        ],
      );

      const answer = await deliverDigest(
        group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b29",
        5,
      );
      expect(answer.json.status).toBe("checked_in");
      expect(answer.json.quantity).toBe(5);
      expect(answer.json.remaining).toBe(1);
      expect(await storedCheckinRows(attendee.id)).toEqual([
        { checked_in: 4 },
        { checked_in: 1 },
      ]);
    });
  },
);
