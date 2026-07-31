import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentProgressForResolution } from "#shared/payment-runtime/progress.ts";
import type { PaymentIgnoreReason } from "#shared/payment-state/lifecycle.ts";
import { SESSION_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { storedStripePayment } from "#test-utils/stripe/provider-fixtures.ts";

const ignoredAs = (reason: PaymentIgnoreReason) =>
  paymentProgressForResolution(storedStripePayment(), {
    reason,
    resource: SESSION_RESOURCE,
    status: "ignore",
  });

describe("what a payment reads as after a notice we act on nothing for", () => {
  test("marks the payment failed when the provider refused it", () => {
    expect(ignoredAs("payment_failed")).toMatchObject({ state: "failed" });
  });

  test("leaves the payment waiting when the notice was not about it", () => {
    // Someone else's notice tells us nothing about our payment, so it stays
    // where it was rather than being written off.
    expect(ignoredAs("not_ours")).toMatchObject({ state: "pending" });
  });
});
