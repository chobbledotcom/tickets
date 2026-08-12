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
} from "#shared/refund-ledger/record.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import {
  BOOKING_AT,
  legacyReference,
  postBooking,
  refundCashAmounts,
  refundLegsOf,
  refundTarget,
  returnedReference,
  sessionReference,
} from "./helpers.ts";

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
          [11, refundLedgerResult([sessionReference("sess-11")])],
          [12, refundLedgerResult([sessionReference("sess-12")])],
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
          [13, refundLedgerResult([], [sessionReference("sess-13")])],
          [
            14,
            refundLedgerResult(
              [],
              [sessionReference("sess-14")],
              [sessionReference("sess-14")],
            ),
          ],
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
          [15, refundLedgerResult([sessionReference("sess-15")])],
          [16, refundLedgerResult([], [sessionReference("sess-16")])],
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
          [17, refundLedgerResult([sessionReference("sess-17")])],
          [18, refundLedgerResult([], [sessionReference("sess-18")])],
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
      expect(errors.lastMessage()).toContain(
        "refund ledger post failed for attendee 18:",
      );
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
            returnedReference("pi-balance-19", ["balance-19"]),
          ],
        },
      ]);

      const references = [
        sessionReference("sess-19"),
        returnedReference("pi-balance-19", ["balance-19"]),
      ];
      expect(posted).toEqual(new Map([[19, refundLedgerResult(references)]]));
      expect(await accountBalance(attendeeAccount(19))).toBe(0);
      expect(await refundCashAmounts(19)).toEqual([1000, 2000]);
    });

    test("posts the second charge's reversal when it comes back later", async () => {
      const attendeeId = 41;
      await postBooking({ attendeeId, eventId: "sess-first" });
      await postBooking({ attendeeId, eventId: "sess-second" });

      await recordAttendeeRefund(attendeeId, [sessionReference("sess-first")]);
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);

      const references = [
        sessionReference("sess-first"),
        sessionReference("sess-second"),
      ];
      expect(await recordAttendeeRefund(attendeeId, references)).toEqual(
        refundLedgerResult(references),
      );
      expect(await refundCashAmounts(attendeeId)).toEqual([5000, 5000]);
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
    });

    test("replaying one returned charge keeps its existing reversal recorded", async () => {
      const attendeeId = 51;
      await postBooking({ attendeeId, eventId: "sess-back" });
      await postBooking({ attendeeId, eventId: "sess-stuck" });
      const returned = [sessionReference("sess-back")];
      await recordAttendeeRefund(attendeeId, returned);
      const transferCount = (await allTransfers()).length;

      expect(await recordAttendeeRefund(attendeeId, returned)).toEqual(
        refundLedgerResult(returned),
      );
      expect((await allTransfers()).length).toBe(transferCount);
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    test("reports a named return that has no ledger group", async () => {
      const attendeeId = 52;
      await postBooking({ attendeeId, eventId: "sess-placed" });

      const placed = sessionReference("sess-placed");
      const missing = sessionReference("sess-missing");
      expect(await recordAttendeeRefund(attendeeId, [placed, missing])).toEqual(
        refundLedgerResult([placed], [missing]),
      );
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    test("does not place two legacy returns on one unmatched payment group", async () => {
      const attendeeId = 53;
      await postBooking({ attendeeId, eventId: "sess-named" });
      await postBooking({ attendeeId, eventId: "sess-one-legacy" });

      const named = sessionReference("sess-named");
      const legacyOne = legacyReference("pi-legacy-one");
      const legacyTwo = legacyReference("pi-legacy-two");
      expect(
        await recordAttendeeRefund(attendeeId, [named, legacyOne, legacyTwo]),
      ).toEqual(refundLedgerResult([named], [legacyOne, legacyTwo]));
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    // A legacy reference names no session, so when only SOME groups came back
    // there is no way to say which one it paid for. Posting the groups we can
    // name and calling that complete leaves its money reversed nowhere and
    // nothing saying so.
    test("reports an unplaceable legacy return as not recorded", async () => {
      const attendeeId = 61;
      await postBooking({ attendeeId, eventId: "sess-a" });
      await postBooking({ attendeeId, eventId: "sess-b" });
      await postBooking({ attendeeId, eventId: "sess-c" });

      // Tracked A and a legacy charge came back; tracked C did not.
      const tracked = sessionReference("sess-a");
      const legacy = legacyReference("pi-legacy");
      const posted = await recordAttendeeRefund(attendeeId, [tracked, legacy]);

      expect(posted).toEqual(refundLedgerResult([tracked], [legacy]));
      // What could be named is still recorded — the money that moved is not
      // thrown away for the part that could not be placed.
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    test("treats an empty attendee list as a no-op", async () => {
      expect(await recordAttendeeRefundsBatch([])).toEqual(new Map());
    });
  },
);
