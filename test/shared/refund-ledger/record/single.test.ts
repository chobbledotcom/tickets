import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  ATTENDEE,
  expectSingleRefundCash,
  postBooking,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("refund ledger > record one attendee", { db: true }, () => {
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
});
