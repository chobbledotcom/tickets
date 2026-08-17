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
import { getDb, setDb } from "#shared/db/client.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import {
  REFUND_LEDGER_BATCH_DATABASE_CALLS,
  recordAttendeeRefund,
  recordAttendeeRefundsBatch,
} from "#shared/refund-ledger/record.ts";
import {
  BOOKING_AT,
  postBooking,
  refundCashAmounts,
  refundLegsOf,
  refundTarget,
  returnedReference,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

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

    test("keeps ledger work fixed for a listing-wide returned set", async () => {
      const attendeeIds = Array.from({ length: 30 }, (_, index) => 30 + index);
      for (const attendeeId of attendeeIds) {
        await postBooking({
          attendeeId,
          eventId: `sess-${attendeeId}`,
        });
      }

      const calls = await runWithQueryLogContext(() =>
        countDatabaseCalls(REFUND_LEDGER_BATCH_DATABASE_CALLS, () =>
          recordAttendeeRefundsBatch(
            attendeeIds.map((attendeeId) =>
              refundTarget(attendeeId, `sess-${attendeeId}`),
            ),
          ),
        ),
      );

      expect(calls).toBe(REFUND_LEDGER_BATCH_DATABASE_CALLS);
      expect(
        refundLegsOf(await allTransfers()).filter(
          (leg) => leg.kind === "refund_cash",
        ).length,
      ).toBe(attendeeIds.length);
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
      expect(errors.lastMessage()).toContain("E_LEDGER_POST");
      expect(errors.lastMessage()).toContain("Refund ledger post failed");
      expect(errors.lastMessage()).toContain("attendee=18");
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

    test("never reports a reference both recorded and unrecorded", async () => {
      const attendeeId = 20;
      await postBooking({ attendeeId, eventId: "sess-found" });
      const found = sessionReference("sess-found");
      const missing = sessionReference("sess-missing");

      const posted = await recordAttendeeRefundsBatch([
        { attendeeId, references: [found] },
        { attendeeId, references: [found, missing] },
      ]);

      expect(posted).toEqual(
        new Map([[attendeeId, refundLedgerResult([found], [missing])]]),
      );
    });

    test("treats an empty attendee list as a no-op", async () => {
      expect(await recordAttendeeRefundsBatch([])).toEqual(new Map());
    });

    test("keeps every returned reference unrecorded when the shared read fails", async () => {
      const target = refundTarget(21, "sess-21");
      const real = getDb();
      setDb(
        proxyMembers(real, {
          execute: () => Promise.reject(new Error("ledger read failed")),
        }),
      );
      try {
        expect(await recordAttendeeRefundsBatch([target])).toEqual(
          new Map([[21, refundLedgerResult([], target.references)]]),
        );
      } finally {
        setDb(real);
      }
      expect(errors.lastMessage()).toContain(
        "Bulk refund ledger preparation failed for 1 attendee records",
      );
      expect(errors.lastMessage()).not.toContain("ledger read failed");
    });

    test("keeps every returned reference unrecorded when the shared write fails", async () => {
      await postBooking({ attendeeId: 22, eventId: "sess-22" });
      const target = refundTarget(22, "sess-22");
      const real = getDb();
      setDb(
        proxyMembers(real, {
          batch: () => Promise.reject(new Error("ledger write failed")),
        }),
      );
      try {
        expect(await recordAttendeeRefundsBatch([target])).toEqual(
          new Map([[22, refundLedgerResult([], target.references)]]),
        );
      } finally {
        setDb(real);
      }
      expect(errors.lastMessage()).toContain(
        "Bulk refund ledger post failed for 1 attendee records",
      );
      expect(errors.lastMessage()).not.toContain("ledger write failed");
    });
  },
);
