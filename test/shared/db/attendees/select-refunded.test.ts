/**
 * The refunded projection against a real ledger.
 *
 * `select.test.ts` pins the SQL this builder emits; these pin what that SQL
 * ANSWERS once a partial reversal exists, which is the case a string test
 * cannot see. A booking whose own money is still with the provider must not
 * read as refunded because a DIFFERENT booking of the same person came back —
 * the scanner and check-in both turn people away on this flag.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { mapRefund } from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransferGroups } from "#shared/accounting/store.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postListingSale } from "#test-utils/ledger.ts";

const PRICE = 500;

/** One person holding two orders, one per listing — the shape a merge leaves
 *  behind, and the only shape a partial reversal can arise in. */
const bookTwoListings = async (): Promise<{
  attendeeId: number;
  cameBack: number;
  stillPaid: number;
}> => {
  const cameBack = await createPaidListing({ name: "Came back" });
  const stillPaid = await createPaidListing({ name: "Still paid" });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [
      { listingId: cameBack.id, pricePaid: PRICE },
      { listingId: stillPaid.id, pricePaid: PRICE },
    ],
    email: "two@example.com",
    name: "Two Orders",
  });
  if (!made.success) throw new Error("booking setup failed");
  const attendeeId = made.attendees[0]!.id;
  for (const listingId of [cameBack.id, stillPaid.id]) {
    await postListingSale({ attendeeId, gross: PRICE, listingId });
  }
  return { attendeeId, cameBack: cameBack.id, stillPaid: stillPaid.id };
};

/** Reverse exactly one of this person's orders, as a partial provider refund
 *  does when a sibling charge is refused. */
const reverseOrderFor = async (
  attendeeId: number,
  listingId: number,
): Promise<void> => {
  const orders: Transfer[][] = [
    ...Map.groupBy(
      (await transfersByAccount(attendeeAccount(attendeeId))).filter(
        (leg) => !leg.kind?.startsWith("refund_"),
      ),
      (leg) => leg.eventGroup,
    ).values(),
  ];
  const target = orders.find((order) =>
    order.some((leg) => leg.destination.id === String(listingId)),
  );
  if (target === undefined) {
    throw new Error(`No order found for listing ${listingId}`);
  }
  await postTransferGroups([
    await mapRefund({
      occurredAt: "2026-08-11T00:00:00.000Z",
      orderLegs: target,
    }),
  ]);
};

const refundedOn = async (
  listingId: number,
  attendeeId: number,
): Promise<number> => {
  const row = (await getAttendeesRaw(listingId)).find(
    (entry) => entry.id === attendeeId,
  );
  if (row === undefined) {
    throw new Error(
      `Attendee ${attendeeId} has no row on listing ${listingId}`,
    );
  }
  return row.refunded;
};

describeWithEnv(
  "db > attendees > refunded after a partial refund",
  { db: true },
  () => {
    describe("one order reversed, another still paid", () => {
      test("the reversed booking reads refunded", async () => {
        const { attendeeId, cameBack } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
      });

      // The fault this closes: the flag was an EXISTS on ANY `refund_cash` leg
      // sourced from the person, so one returned charge marked every booking
      // they held. The scanner then dropped them from the check-in list and
      // reported "refunded" at the door for an event they had paid for and not
      // got back.
      test("the booking still with the provider does not", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(stillPaid, attendeeId)).toBe(0);
      });

      test("reversing both leaves neither booking paid", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);
        await reverseOrderFor(attendeeId, stillPaid);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
        expect(await refundedOn(stillPaid, attendeeId)).toBe(1);
      });
    });
  },
);
