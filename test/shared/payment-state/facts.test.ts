import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import {
  storedPaymentFactIssue,
  storedPaymentFacts,
} from "#shared/payment-state/facts.ts";
import {
  PAYMENT_TIME,
  paymentSessionInput,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";

const paymentSession = (): PaymentSession => ({
  ...paymentSessionInput(),
  ...sessionProgress(),
  createdAt: PAYMENT_TIME,
  leaseExpiresAt: null,
  revision: 1,
  updatedAt: PAYMENT_TIME,
});

describe("stored payment facts", () => {
  test("copies only facts that identify the payment", () => {
    const payment = paymentSession();

    expect(storedPaymentFacts(payment)).toEqual({
      accountId: payment.accountId,
      bookingIntent: payment.bookingIntent,
      expected: payment.expected,
      mode: payment.mode,
    });
  });

  test("accepts the same facts regardless of object key order", () => {
    const payment = paymentSession();
    const { address, ...rest } = payment.bookingIntent;

    expect(
      storedPaymentFactIssue(payment, {
        ...storedPaymentFacts(payment),
        bookingIntent: { ...rest, address },
      }),
    ).toBeNull();
  });

  test("reports an account mismatch separately", () => {
    const payment = paymentSession();

    expect(
      storedPaymentFactIssue(payment, {
        ...storedPaymentFacts(payment),
        accountId: "another-account",
      }),
    ).toBe("mismatched_account");
  });

  for (const [name, change] of [
    ["mode", { mode: "live" as const }],
    ["expected money", { expected: { amount: 999, currency: "GBP" } }],
    [
      "booking intent",
      {
        bookingIntent: {
          ...paymentSession().bookingIntent,
          name: "Another buyer",
        },
      },
    ],
  ] as const) {
    test(`reports changed ${name} as malformed provider data`, () => {
      const payment = paymentSession();

      expect(
        storedPaymentFactIssue(payment, {
          ...storedPaymentFacts(payment),
          ...change,
        }),
      ).toBe("malformed_response");
    });
  }
});
