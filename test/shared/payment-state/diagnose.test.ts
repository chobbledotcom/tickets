import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { hasSettled, outcomeOf } from "#shared/payment-state/diagnose.ts";
import { PaymentResolutionSchema } from "#shared/payment-state/lifecycle.ts";
import {
  chargeLeg,
  partlyRefundedCharge,
  paymentObservation,
  refundObservation,
  sessionResource,
} from "./fixtures.ts";

describe("what one reading of a payment comes to", () => {
  for (const [name, observation, expected] of [
    ["money taken and kept", paymentObservation(), "ready"],
    [
      "money taken with nothing naming it",
      paymentObservation({ charges: undefined }),
      "conflict",
    ],
    [
      "part of the money given back",
      paymentObservation({ charges: [partlyRefundedCharge()] }),
      "conflict",
    ],
    [
      "all of the money given back",
      paymentObservation({
        charges: [
          chargeLeg({
            confirmedRefunded: { amount: 100, currency: "GBP" },
            refunds: [refundObservation()],
          }),
        ],
      }),
      "fully_refunded",
    ],
    [
      "money on its way back",
      paymentObservation({
        charges: [
          chargeLeg({ refunds: [refundObservation({ status: "pending" })] }),
        ],
      }),
      "refund_pending",
    ],
  ] as const) {
    test(`calls ${name} ${expected}`, () => {
      expect(outcomeOf(observation).kind).toBe(expected);
    });
  }

  test("names money given back in part as a partly refunded problem", () => {
    const outcome = outcomeOf(
      paymentObservation({ charges: [partlyRefundedCharge()] }),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "partial_refund",
    );
  });

  // The whole reason the reading and the problem are checked against each
  // other: a stored problem that names something its own reading does not show
  // would send the owner after money that is not the money in front of them.
  test("refuses a stored problem its own reading does not show", () => {
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        issue: { kind: "failed_refund" },
        observation: paymentObservation({ charges: [partlyRefundedCharge()] }),
        resource: sessionResource,
        status: "conflict",
      }),
    ).toThrow();
  });

  // Nothing has been decided yet, so there is nothing for a stored answer to
  // agree or disagree with.
  for (const [name, status, settled] of [
    ["money taken", "paid", true],
    ["nothing owed", "no_payment_required", true],
    ["a checkout still going", "pending", false],
    ["a checkout that failed", "failed", false],
  ] as const) {
    test(`${settled ? "counts" : "does not count"} ${name} as finished`, () => {
      expect(hasSettled(paymentObservation({ status }))).toBe(settled);
    });
  }

  test("refuses a stored problem whose reading has not finished", () => {
    expect(() =>
      v.parse(PaymentResolutionSchema, {
        issue: { kind: "partial_refund" },
        observation: paymentObservation({ status: "pending" }),
        resource: sessionResource,
        status: "conflict",
      }),
    ).toThrow();
  });
});
