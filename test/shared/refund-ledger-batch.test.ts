import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import {
  recordAttendeeRefund,
  recordAttendeeRefundsBatch,
} from "#shared/refund-ledger.ts";
import { describeWithEnv } from "#test-utils";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  BOOKING_AT,
  postBooking,
  refundCashAmounts,
  refundLegsOf,
  refundReference,
  refundTarget,
  sessionReference,
} from "./refund-ledger-helpers.ts";

describeWithEnv(
  "refund-ledger > recordAttendeeRefundsBatch",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("posts every clean reversal in one batch and reports each posted", async () => {
      await postBooking({ attendeeId: 11, eventId: "sess-11" });
      await postBooking({ attendeeId: 12, eventId: "sess-12" });

      const posted = await recordAttendeeRefundsBatch([
        refundTarget(11, "sess-11"),
        refundTarget(12, "sess-12"),
      ]);
      expect(posted).toEqual(
        new Map([
          [11, true],
          [12, true],
        ]),
      );
      expect(await accountBalance(revenueAccount(1))).toBe(0);
      for (const id of [11, 12]) {
        expect(
          refundLegsOf(await transfersByAccount(attendeeAccount(id))).filter(
            (leg) => leg.kind === "refund_cash",
          ).length,
        ).toBe(1);
      }
    });

    test("reports false for guard-skipped attendees and posts nothing", async () => {
      await postBooking({
        amountPaid: 2000,
        attendeeId: 14,
        eventId: "sess-14",
        lines: [{ gross: 10000, listingId: 1 }],
      });
      const before = (await allTransfers()).length;

      const posted = await recordAttendeeRefundsBatch([
        refundTarget(13, "sess-13"),
        refundTarget(14, "sess-14"),
      ]);
      expect(posted).toEqual(
        new Map([
          [13, false],
          [14, false],
        ]),
      );
      expect((await allTransfers()).length).toBe(before);
    });

    test("on a failed batch, keeps already-refunded true and an unrecoverable post false", async () => {
      await postBooking({ attendeeId: 15, eventId: "sess-15" });
      await recordAttendeeRefund(15, [sessionReference("sess-15")]);
      await postBooking({ attendeeId: 16, eventId: "sess-16" });

      const sale16 = (await transfersByAccount(attendeeAccount(16))).find(
        (leg) => leg.kind === "sale",
      )!;
      const collidingRef = await legReference([
        "refund",
        sale16.eventGroup,
        sale16.reference,
      ]);
      await postTransfers([
        {
          amount: 100,
          destination: revenueAccount(98),
          eventGroup: "blocker-16",
          kind: "sale",
          occurredAt: BOOKING_AT,
          reference: collidingRef,
          source: attendeeAccount(98),
        },
      ]);

      const posted = await recordAttendeeRefundsBatch([
        refundTarget(15, "sess-15"),
        refundTarget(16, "sess-16"),
      ]);
      expect(posted).toEqual(
        new Map([
          [15, true],
          [16, false],
        ]),
      );
      expect(
        refundLegsOf(await transfersByAccount(attendeeAccount(16))).length,
      ).toBe(0);
    });

    test("recovers the clean refunds when one group in the batch conflicts", async () => {
      await postBooking({ attendeeId: 17, eventId: "sess-17" });
      await postBooking({ attendeeId: 18, eventId: "sess-18" });

      const sale18 = (await transfersByAccount(attendeeAccount(18))).find(
        (leg) => leg.kind === "sale",
      )!;
      const collidingRef = await legReference([
        "refund",
        sale18.eventGroup,
        sale18.reference,
      ]);
      await postTransfers([
        {
          amount: 100,
          destination: revenueAccount(97),
          eventGroup: "blocker-18",
          kind: "sale",
          occurredAt: BOOKING_AT,
          reference: collidingRef,
          source: attendeeAccount(97),
        },
      ]);

      const posted = await recordAttendeeRefundsBatch([
        refundTarget(17, "sess-17"),
        refundTarget(18, "sess-18"),
      ]);
      expect(posted).toEqual(
        new Map([
          [17, true],
          [18, false],
        ]),
      );
      expect(
        refundLegsOf(await transfersByAccount(attendeeAccount(17))).filter(
          (leg) => leg.kind === "refund_cash",
        ).length,
      ).toBe(1);
      expect(
        refundLegsOf(await transfersByAccount(attendeeAccount(18))).length,
      ).toBe(0);
      const logged = errors.calls.map((call) => String(call.args[0]));
      expect(
        logged.some((message) => message.includes("bulk refund batch failed")),
      ).toBe(true);
      expect(errors.lastMessage()).toContain("E_LEDGER_POST");
    });

    test("posts all refund groups for a balance-settled attendee in a bulk batch", async () => {
      await postBooking({
        amountPaid: 1000,
        attendeeId: 19,
        eventId: "sess-19",
        lines: [{ gross: 3000, listingId: 1 }],
      });
      await postTransfers([
        {
          amount: 2000,
          destination: attendeeAccount(19),
          eventGroup: await balanceEventGroup("balance-19"),
          kind: "payment",
          occurredAt: BOOKING_AT,
          reference: "balance-pay-19",
          source: WORLD,
        },
      ]);

      const posted = await recordAttendeeRefundsBatch([
        {
          attendeeId: 19,
          references: [
            sessionReference("sess-19"),
            refundReference("pi-balance-19", ["balance-19"]),
          ],
        },
      ]);

      expect(posted).toEqual(new Map([[19, true]]));
      expect(await accountBalance(attendeeAccount(19))).toBe(0);
      expect(await refundCashAmounts(19)).toEqual([1000, 2000]);
    });

    test("treats an empty attendee list as a no-op", async () => {
      expect(await recordAttendeeRefundsBatch([])).toEqual(new Map());
    });
  },
);
