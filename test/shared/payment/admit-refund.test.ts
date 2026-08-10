import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { admitRefund } from "#shared/payment/admit-refund.ts";
import type { ObservationOutcome } from "#shared/payment/diagnose.ts";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { ChargeLeg } from "#shared/payment/resources.ts";
import {
  chargeLeg,
  partlyRefundedCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";

/** Money back on every penny of this charge. */
const fullyRefundedCharge = (): ChargeLeg =>
  chargeLeg({
    confirmedRefunded: { amount: 100, currency: "GBP" },
    refunds: [refundObservation()],
  });

describe("whether a refund may be sent", () => {
  for (const [name, outcome, expected] of [
    ["nothing has gone back yet", { kind: "ready" }, "send"],
    [
      "the money is already back",
      { kind: "fully_refunded" },
      "already_returned",
    ],
    ["a refund is on its way", { kind: "refund_pending" }, "in_flight"],
    [
      "the owner has to look at it",
      { issue: { kind: "partial_refund" }, kind: "conflict" },
      "refused",
    ],
  ] as const satisfies readonly (readonly [
    string,
    ObservationOutcome,
    string,
  ])[]) {
    test(`answers ${expected} when ${name}`, () => {
      expect(admitRefund(outcome).kind).toBe(expected);
    });
  }

  test("carries the problem through so the refusal can name it", () => {
    const admission = admitRefund({
      issue: { kind: "refund_exceeds_capture" },
      kind: "conflict",
    });

    expect(admission).toEqual({
      issue: { kind: "refund_exceeds_capture" },
      kind: "refused",
    });
  });

  // The whole point of the guard: these are the readings that must not reach a
  // provider, judged from charge facts rather than from a hand-written outcome.
  for (const [name, charges, expected] of [
    ["an untouched charge", [chargeLeg()], "send"],
    [
      "a charge already given back",
      [fullyRefundedCharge()],
      "already_returned",
    ],
    [
      "a charge with money on its way back",
      [chargeLeg({ refunds: [refundObservation({ status: "pending" })] })],
      "in_flight",
    ],
    ["a part-refunded charge", [partlyRefundedCharge()], "refused"],
    [
      "a charge that gave back more than it took",
      [
        chargeLeg({
          confirmedRefunded: { amount: 140, currency: "GBP" },
        }),
      ],
      "refused",
    ],
    [
      "one charge back and one not",
      [fullyRefundedCharge(), chargeLeg()],
      "refused",
    ],
  ] as const satisfies readonly (readonly [
    string,
    readonly ChargeLeg[],
    string,
  ])[]) {
    test(`answers ${expected} for ${name}`, () => {
      expect(admitRefund(refundOutcomeOf([...charges])).kind).toBe(expected);
    });
  }
});
