import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { terminalPaymentOutcome } from "#shared/payment-runtime/terminal.ts";
import { storedStripePayment } from "#test-utils/stripe/provider-fixtures.ts";

/** What a repeated callback makes of a payment that has already finished. */
const replayed = (changes: Partial<PaymentSession>) =>
  terminalPaymentOutcome(storedStripePayment(changes), "callback");

describe("a callback about a payment that has already finished", () => {
  test("puts a refused payment in front of the owner", () => {
    expect(replayed({ state: "failed" })).toMatchObject({
      status: "conflict",
    });
  });

  test("puts a payment already needing a decision back in front of them", () => {
    expect(replayed({ state: "needs_action" })).toMatchObject({
      status: "conflict",
    });
  });

  test("says a fully refunded booking is refunded, with nothing to hand over", () => {
    expect(
      replayed({ attendeeId: 42, completion: null, state: "fully_refunded" }),
    ).toMatchObject({ status: "fully_refunded" });
  });

  test("refuses a finished payment whose work was never done", () => {
    expect(() =>
      replayed({
        attendeeId: null,
        completionState: "none",
        state: "completed",
      }),
    ).toThrow("has no completed effects");
  });
});
