/** The persisted domain words of the mappers' HMAC derivations. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  bookingEventGroup,
  mapBooking,
  refundEventGroup,
} from "#accounting/mappers.ts";
import { eventGroup, legReference } from "#accounting/refs.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv(
  "accounting > mappers > persisted domains",
  {
    encryptionKey: true,
  },
  () => {
    // Stored event groups and leg references are recomputed by later code:
    // replay lookups, the reverses-group backfill, merge sale lookups. Changing
    // a domain word changes every new key while historical rows keep the old
    // one, so the words are part of the storage format and are pinned here
    // against their spelled tuples.
    test("bookingEventGroup derives from the spelled booking domain", async () => {
      expect(await bookingEventGroup("session-7")).toBe(
        await eventGroup(["booking", "session-7"]),
      );
    });

    test("refundEventGroup derives from the spelled refund domain", async () => {
      const booking = await eventGroup(["booking", "session-7"]);
      expect(await refundEventGroup(booking)).toBe(
        await eventGroup(["refund", booking]),
      );
    });

    test("a modifier leg's reference derives from the spelled tuple", async () => {
      const [modifierLeg] = await mapBooking({
        amountPaid: 0,
        attendeeId: 3,
        bookingFee: 0,
        eventId: "mod-pin",
        lines: [],
        modifiers: [{ delta: -250, modifierId: 7 }],
        occurredAt: "2026-06-21T00:00:00.000Z",
      });
      expect(modifierLeg).toBeDefined();
      expect(modifierLeg!.reference).toBe(
        await legReference(["booking", "mod-pin", "mod", 7]),
      );
    });
  },
);
