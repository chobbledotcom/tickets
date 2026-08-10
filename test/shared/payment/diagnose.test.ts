import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import {
  chargeMoneyWith,
  partlyRefundedCharge,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

/** The problem a reading is named by, or nothing when it holds together. */
const problemKind = (charges: ChargeMoney[]): string | undefined => {
  const outcome = refundOutcomeOf(charges);
  return outcome.kind === "conflict" ? outcome.issue.kind : undefined;
};

describe("what charges alone come to, with no agreed total", () => {
  for (const [name, charges, expected] of [
    ["money taken and kept", [chargeMoneyWith()], "ready"],
    ["part of the money given back", [partlyRefundedCharge()], "conflict"],
    [
      "more money back than was ever taken",
      [
        chargeMoneyWith({
          confirmedRefunded: { amount: 150, currency: "GBP" },
        }),
      ],
      "conflict",
    ],
    [
      "money on its way back",
      [
        chargeMoneyWith({
          refunds: [refundObservation({ status: "pending" })],
        }),
      ],
      "refund_pending",
    ],
    [
      "all of the money given back",
      [
        chargeMoneyWith({
          confirmedRefunded: { amount: 100, currency: "GBP" },
          refunds: [refundObservation()],
        }),
      ],
      "fully_refunded",
    ],
  ] as const satisfies readonly (readonly [
    string,
    readonly ChargeMoney[],
    string,
  ])[]) {
    test(`calls ${name} ${expected}`, () => {
      expect(refundOutcomeOf([...charges]).kind).toBe(expected);
    });
  }

  test("names money given back in part as a partly refunded problem", () => {
    expect(problemKind([partlyRefundedCharge()])).toBe("partial_refund");
  });

  test("names more money back than was taken as overspending the charge", () => {
    expect(
      problemKind([
        chargeMoneyWith({
          confirmedRefunded: { amount: 150, currency: "GBP" },
        }),
      ]),
    ).toBe("refund_exceeds_capture");
  });

  test("names a refund in a different currency from its charge", () => {
    expect(
      problemKind([
        chargeMoneyWith({
          refunds: [
            refundObservation({ amount: { amount: 100, currency: "USD" } }),
          ],
        }),
      ]),
    ).toBe("refund_exceeds_capture");
  });

  test("calls a refund the provider could not finish a problem", () => {
    // Only a refund the provider actually tried and failed counts: the owner
    // has to be told, because the money is still with us and nothing else
    // will try again.
    expect(
      problemKind([
        chargeMoneyWith({
          refunds: [
            refundObservation({ reason: "provider_failed", status: "failed" }),
          ],
        }),
      ]),
    ).toBe("failed_refund");
  });

  test("calls one leg given back among several a partly refunded problem", () => {
    expect(
      problemKind([
        chargeMoneyWith({
          captured: { amount: 50, currency: "GBP" },
          confirmedRefunded: { amount: 50, currency: "GBP" },
        }),
        chargeMoneyWith({ captured: { amount: 50, currency: "GBP" } }),
      ]),
    ).toBe("partial_refund");
  });

  test("throws on a reading holding two refunds in flight", () => {
    // No M4 evidence can carry two pending refunds: the only pending refund a
    // reading holds is the answer to its own single attempt. The judge fails
    // loudly instead of letting broken evidence pass as settled.
    expect(() =>
      refundOutcomeOf([
        chargeMoneyWith({
          refunds: [
            refundObservation({
              amount: { amount: 40, currency: "GBP" },
              status: "pending",
            }),
            refundObservation({
              amount: { amount: 40, currency: "GBP" },
              refund: { ...refundResource, id: "re_2" },
              status: "pending",
            }),
          ],
        }),
      ]),
    ).toThrow("more than one refund in flight");
  });

  // The rules that compare what was owed against what was observed cannot run
  // without an agreed total, so a reference carrying none is judged on the
  // provider's own numbers instead of against a stand-in that was never agreed.
  for (const [name, charges] of [
    [
      "two legs adding up to less than any total",
      [
        chargeMoneyWith({ captured: { amount: 1, currency: "GBP" } }),
        chargeMoneyWith({ captured: { amount: 1, currency: "GBP" } }),
      ],
    ],
    [
      "a charge taken in a currency the site no longer sells in",
      [
        chargeMoneyWith({
          captured: { amount: 100, currency: "USD" },
          confirmedRefunded: { amount: 0, currency: "USD" },
        }),
      ],
    ],
  ] as const satisfies readonly (readonly [string, readonly ChargeMoney[]])[]) {
    test(`sends money back for ${name}`, () => {
      expect(refundOutcomeOf([...charges]).kind).toBe("ready");
    });
  }
});
