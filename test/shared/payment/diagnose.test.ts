import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundOutcomeOf } from "#payment/diagnose.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import {
  chargeMoneyWith,
  gbp,
  partlyRefundedCharge,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

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
    [
      "money on its way back",
      [chargeMoneyWith({ refunds: [stillGoing(100)] })],
      "refund_pending",
    ],
    [
      "all of the money given back",
      [
        chargeMoneyWith({
          confirmedRefunded: gbp(100),
          refunds: [refundObservation()],
        }),
      ],
      "fully_refunded",
    ],
    [
      "part of the money given back",
      [partlyRefundedCharge()],
      "partial_refund",
    ],
    [
      "one leg given back among several",
      [
        chargeMoneyWith({ captured: gbp(50), confirmedRefunded: gbp(50) }),
        chargeMoneyWith({ captured: gbp(50) }),
      ],
      "partial_refund",
    ],
    [
      "more money back than was ever taken",
      [chargeMoneyWith({ confirmedRefunded: gbp(150) })],
      "refund_exceeds_capture",
    ],
    [
      "a refund in a different currency from its charge",
      [chargeMoneyWith({ refunds: [refundObservation({ amount: usd(100) })] })],
      "refund_exceeds_capture",
    ],
    [
      // No money moved, so it settles as not-happening and a fresh attempt is
      // legitimate.
      "a refund the provider tried and could not finish",
      [
        chargeMoneyWith({
          refunds: [
            refundObservation({ reason: "provider_failed", status: "failed" }),
          ],
        }),
      ],
      "ready",
    ],
    [
      // But not when money has already come back: sending again there pays the
      // buyer twice, so a failed attempt beside a returned one still parks.
      "a failed attempt beside money already returned",
      [
        chargeMoneyWith({
          confirmedRefunded: gbp(40),
          refunds: [
            refundObservation({ amount: gbp(40) }),
            refundObservation({
              amount: gbp(30),
              reason: "provider_failed",
              refund: { ...refundResource, id: "re_2" },
              status: "failed",
            }),
          ],
        }),
      ],
      "partial_refund",
    ],
    [
      // Even the smallest amount back must stop a second send. Provider
      // failures can still report money they returned before failing.
      "a failed refund that still returned one penny",
      [
        chargeMoneyWith({
          confirmedRefunded: gbp(1),
          refunds: [
            refundObservation({
              amount: gbp(1),
              reason: "provider_failed",
              status: "failed",
            }),
          ],
        }),
      ],
      "partial_refund",
    ],
    // The rules comparing what was owed against what was observed cannot run
    // without an agreed total, so a reference carrying none is judged on the
    // provider's own numbers rather than against a stand-in nobody agreed.
    [
      "two legs adding up to less than any total",
      [
        chargeMoneyWith({ captured: gbp(1) }),
        chargeMoneyWith({ captured: gbp(1) }),
      ],
      "ready",
    ],
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

  test("parks a reading holding two refunds in flight for owner review", () => {
    expect(
      verdict(
        chargeMoneyWith({ refunds: [stillGoing(40), stillGoing(40, "re_2")] }),
      ),
    ).toBe("multiple_pending_refunds");
  });
});
