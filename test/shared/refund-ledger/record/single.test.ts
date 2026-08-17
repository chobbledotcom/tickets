import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  ATTENDEE,
  expectSingleRefundCash,
  postBooking,
  readsTransfers,
  sessionReference,
  withBrokenLedger,
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

    expect(
      await withBrokenLedger(readsTransfers, "ledger read failed", () =>
        recordAttendeeRefund(ATTENDEE, [reference]),
      ),
    ).toEqual(refundLedgerResult([], [reference]));
    expect(errors.lastMessage()).toContain("Refund ledger preparation failed");
    expect(errors.lastMessage()).toContain("attendee=3");
    expect(errors.lastMessage()).not.toContain("ledger read failed");
  });
});
