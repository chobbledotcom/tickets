import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatPaymentError } from "#routes/api/payment-processing/index.ts";
import { registerStagedRefundTests } from "#test/features/api/payment-processing/staged-refund-cases.ts";

registerStagedRefundTests();

test("tells the buyer when a refund is still being processed", () => {
  expect(
    formatPaymentError({
      error: "We couldn't complete your booking.",
      refundStatus: "pending",
      success: false,
    }),
  ).toBe("We couldn't complete your booking. Your refund is being processed.");
});
