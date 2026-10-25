/** The scan API's quantity read: a queued check-in that names how many
 * people it admits. The door admits exactly that many on the delivery's
 * first send, a resend admits nobody and answers what the first send took,
 * and a quantity the booking cannot supply is refused, not capped. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deliverDigest,
  doorDigest,
  partyOfThree,
  sendTwiceLanding,
} from "#test/features/admin/scan-answer/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "a queued delivery that names its quantity",
  { db: true },
  () => {
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

    test("a quantity larger than the booking holds is refused and admits nothing", async () => {
      const { door, attendee } = await partyOfThree();

      const refused = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b22",
        4,
      );
      expect(refused.response.status).toBe(400);
      expect(refused.json.error).toBe("Invalid quantity");
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);

      // The refusal spoiled nothing: the party's whole size still admits on
      // a delivery of its own.
      const after = await deliverDigest(
        door.group.id,
        attendee.ticket_token,
        "018f3c2e-1b7d-7f31-9d4a-2f5c8e6a9b23",
        3,
      );
      expect(after.json.status).toBe("checked_in");
      expect(after.json.quantity).toBe(3);
      expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 3 }]);
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
