/**
 * The refunded projection where one person holds TWO orders for the SAME
 * listing — the shape a merge of two people (or two separate daily bookings)
 * leaves behind. Each order's reversal must belong to that order alone: the
 * still-paid order's ticket must stay live at the door.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTwoOrdersOnOneListing,
  DAYS,
  refundedOn,
  reverseOrderGroup,
} from "./support.ts";

describeWithEnv(
  "db > attendees > refunded with two orders on one listing",
  { db: true },
  () => {
    test("reversing one order's charge does not refund the other", async () => {
      const { attendeeId, listingId, secondGroup } =
        await bookTwoOrdersOnOneListing();
      await reverseOrderGroup(attendeeId, secondGroup);

      expect(await refundedOn(listingId, attendeeId, DAYS[1])).toBe(1);
      expect(await refundedOn(listingId, attendeeId, DAYS[0])).toBe(0);
    });

    test("before any reversal, neither order reads refunded", async () => {
      const { attendeeId, listingId } = await bookTwoOrdersOnOneListing();

      expect(await refundedOn(listingId, attendeeId, DAYS[0])).toBe(0);
      expect(await refundedOn(listingId, attendeeId, DAYS[1])).toBe(0);
    });
  },
);
