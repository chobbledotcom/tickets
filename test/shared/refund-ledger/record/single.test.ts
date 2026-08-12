import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, setDb } from "#shared/db/client.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  ATTENDEE,
  expectSingleRefundCash,
  postBooking,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

describeWithEnv("refund ledger > record one attendee", { db: true }, () => {
  const errors = setupErrorSpy();

  test("passes the refund reason into the recorded ledger legs", async () => {
    await postBooking();
    await recordAttendeeRefund(
      ATTENDEE,
      [sessionReference("sess-1")],
      "customer_request",
    );

    const cash = await expectSingleRefundCash(5000);
    expect(cash.memo).toBe("customer_request");
  });

  test("keeps every returned reference unrecorded when the ledger read fails", async () => {
    const reference = sessionReference("sess-read-failed");
    const real = getDb();
    setDb(
      proxyMembers(real, {
        execute: () => Promise.reject(new Error("ledger read failed")),
      }),
    );
    try {
      expect(await recordAttendeeRefund(ATTENDEE, [reference])).toEqual(
        refundLedgerResult([], [reference]),
      );
    } finally {
      setDb(real);
    }
    expect(errors.lastMessage()).toContain(
      "refund ledger preparation failed for attendee 3: Error: ledger read failed",
    );
  });
});
