/**
 * The refunded projection for a free line of an order — a package's free
 * member, or a free listing beside a fee. The free line has no sale leg of
 * its own, so it reads the order as a whole: refunded only when the order was
 * reversed AND every paid sale of it came back. A fee-only order (stamped,
 * legs to its name, but no sale leg anywhere) must not read refunded off the
 * vacuously-true "every sale came back" — the order's own reversal is the
 * positive evidence.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { mapRefund } from "#accounting/mappers.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookPaidAndFreeOrder,
  orderWithAFeeAndAFreeLine,
  orderWithPaidLinesAndAFreeMember,
  REVERSED_AT,
  refundedOn,
  reverseOrderFor,
  reverseSales,
} from "./support.ts";

describeWithEnv(
  "db > attendees > refunded for a free line",
  { db: true },
  () => {
    describe("a free line of a wholly-reversed order", () => {
      test("reads refunded when the order's sale came back", async () => {
        const { attendeeId, freeId, paidId } = await bookPaidAndFreeOrder();
        await reverseOrderFor(attendeeId, paidId);

        expect(await refundedOn(paidId, attendeeId)).toBe(1);
        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });

      test("stays live while the order's sale is still with the provider", async () => {
        const { attendeeId, freeId, paidId } = await bookPaidAndFreeOrder();

        expect(await refundedOn(paidId, attendeeId)).toBe(0);
        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("stays live while only SOME of the order's sales came back", async () => {
        // Two paid lines and one free line in one order: returning one paid
        // line's money leaves the other paid line live, so the free member's
        // ticket stays live too.
        const first = await createPaidListing({ name: "Part one" });
        const second = await createPaidListing({ name: "Part two" });
        const { attendeeId, freeId, sales } =
          await orderWithPaidLinesAndAFreeMember(
            [first.id, second.id],
            "partially-reversed@example.com",
          );
        await reverseSales([sales[0]!]);

        expect(await refundedOn(first.id, attendeeId)).toBe(1);
        expect(await refundedOn(second.id, attendeeId)).toBe(0);
        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("reads refunded once every sale of the order came back", async () => {
        const first = await createPaidListing({ name: "Whole one" });
        const second = await createPaidListing({ name: "Whole two" });
        const { attendeeId, freeId, sales } =
          await orderWithPaidLinesAndAFreeMember(
            [first.id, second.id],
            "wholly-reversed@example.com",
          );
        await reverseSales(sales);

        expect(await refundedOn(first.id, attendeeId)).toBe(1);
        expect(await refundedOn(second.id, attendeeId)).toBe(1);
        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });
    });

    describe("a free line of an order with no sale legs", () => {
      test("stays live while nothing was reversed", async () => {
        const { attendeeId, freeId, legs } = await orderWithAFeeAndAFreeLine();
        expect(legs.filter((leg) => leg.kind === "sale")).toEqual([]);

        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("reads refunded once the fee order itself was reversed", async () => {
        const { attendeeId, freeId, legs } = await orderWithAFeeAndAFreeLine();
        await postTransferGroups([
          await mapRefund({ occurredAt: REVERSED_AT, orderLegs: legs }),
        ]);

        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });
    });
  },
);
