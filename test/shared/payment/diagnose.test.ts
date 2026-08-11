import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { chargeMoneyWith, gbp, partlyRefundedCharge, refundObservation, refundResource } from "#test-utils/payment-state.ts";

/** What a reading is named by: its problem when it has one, otherwise how far
 *  the payment has got. */
const verdict = (...charges: ChargeMoney[]): string => {
  const outcome = refundOutcomeOf(charges);
  return outcome.kind === "conflict" ? outcome.issue.kind : outcome.kind;
};

const usd = (amount: number) => ({ amount, currency: "USD" });
const stillGoing = (amount: number, id?: string) =>
  refundObservation({
    amount: gbp(amount),
    ...(id === undefined ? {} : { refund: { ...refundResource, id } }),
    status: "pending",
  });

describe("what charges alone come to, with no agreed total", () => {
  /** Every reading the judge can meet, and the one word it answers with. A
   *  problem outranks progress, so a reading with one is named by it. */
  const readings: readonly [string, ChargeMoney[], string][] = [
    ["money taken and kept", [chargeMoneyWith()], "ready"],
    ["money on its way back", [chargeMoneyWith({ refunds: [stillGoing(100)] })], "refund_pending"],
    [
      "all of the money given back",
      [chargeMoneyWith({ confirmedRefunded: gbp(100), refunds: [refundObservation()] })],
      "fully_refunded",
    ],
    ["part of the money given back", [partlyRefundedCharge()], "partial_refund"],
    [
      "one leg given back among several",
      [chargeMoneyWith({ captured: gbp(50), confirmedRefunded: gbp(50) }), chargeMoneyWith({ captured: gbp(50) })],
      "partial_refund",
    ],
    ["more money back than was ever taken", [chargeMoneyWith({ confirmedRefunded: gbp(150) })], "refund_exceeds_capture"],
    [
      "a refund in a different currency from its charge",
      [chargeMoneyWith({ refunds: [refundObservation({ amount: usd(100) })] })],
      "refund_exceeds_capture",
    ],
    [
      "a refund the provider tried and could not finish",
      // Only a refund actually attempted counts: the money is still with us
      // and nothing else will try again, so the owner has to be told.
      [chargeMoneyWith({ refunds: [refundObservation({ reason: "provider_failed", status: "failed" })] })],
      "failed_refund",
    ],
    // The rules comparing what was owed against what was observed cannot run
    // without an agreed total, so a reference carrying none is judged on the
    // provider's own numbers rather than against a stand-in nobody agreed.
    ["two legs adding up to less than any total", [chargeMoneyWith({ captured: gbp(1) }), chargeMoneyWith({ captured: gbp(1) })], "ready"],
    [
      "a charge taken in a currency the site no longer sells in",
      [chargeMoneyWith({ captured: usd(100), confirmedRefunded: usd(0) })],
      "ready",
    ],
  ];

  for (const [name, charges, expected] of readings) {
    test(`calls ${name} ${expected}`, () => {
      expect(verdict(...charges)).toBe(expected);
    });
  }

  test("throws on a reading holding two refunds in flight", () => {
    // No M4 evidence can carry two pending refunds: the only pending refund a
    // reading holds is the answer to its own single attempt. The judge fails
    // loudly instead of letting broken evidence pass as settled.
    expect(() =>
      verdict(chargeMoneyWith({ refunds: [stillGoing(40), stillGoing(40, "re_2")] })),
    ).toThrow("more than one refund in flight");
  });
});
