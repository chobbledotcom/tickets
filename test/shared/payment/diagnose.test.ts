import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { SettledReading } from "#shared/payment/diagnose.ts";
import { hasSettled, outcomeOf } from "#shared/payment/diagnose.ts";
import type { PaymentObservation } from "#shared/payment/observation.ts";
import type { ChargeLeg } from "#shared/payment/resources.ts";
import {
  chargeLeg,
  chargeResource,
  noPaymentRequiredObservation,
  partlyRefundedCharge,
  paymentObservation,
  refundObservation,
  refundResource,
} from "#test-utils/payment-state.ts";

/** A reading the case is about, once we have said out loud that it finished.
 *  A fixture that has not is the test being wrong, not the code. */
const finished = (observation: PaymentObservation): SettledReading => {
  if (!hasSettled(observation)) {
    throw new Error(`This reading has not finished: ${observation.status}`);
  }
  return observation;
};

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
      expect(outcomeOf(finished(observation)).kind).toBe(expected);
    });
  }

  test("names money given back in part as a partly refunded problem", () => {
    const outcome = outcomeOf(
      finished(paymentObservation({ charges: [partlyRefundedCharge()] })),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "partial_refund",
    );
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

  // The judge itself refuses these readings, so no path that fronts it can
  // call the money settled on them.
  for (const [name, expectedConflict, observation] of [
    [
      "a total the provider disagrees with",
      "provider_total_mismatch",
      paymentObservation({ providerTotal: { amount: 99, currency: "GBP" } }),
    ],
    [
      "money taken in a different currency",
      "currency_mismatch",
      paymentObservation({ providerTotal: { amount: 100, currency: "USD" } }),
    ],
    [
      "a charge belonging to another checkout",
      "resource_mismatch",
      paymentObservation({
        charges: [
          chargeLeg({
            resource: {
              id: "pi_1",
              kind: "stripe_payment_intent",
              parentId: "cs_somebody_else",
              provider: "stripe",
            },
          }),
        ],
      }),
    ],
  ] as const) {
    test(`refuses a payment called ready on ${name}`, () => {
      const outcome = outcomeOf(finished(observation));
      expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
        expectedConflict,
      );
    });
  }

  // A refund names the charge it came from. Checking only half of that would
  // let one provider's refund be read as hanging off another's money.
  for (const [name, refund] of [
    [
      "from another provider",
      {
        ...refundObservation(),
        refund: {
          ...refundResource,
          kind: "square_refund",
          provider: "square",
        },
      },
    ],
    [
      "hanging off other money",
      {
        ...refundObservation(),
        refund: { ...refundResource, parentId: "pi_somebody_else" },
      },
    ],
  ] as const) {
    test(`calls a refund ${name} a problem`, () => {
      const outcome = outcomeOf(
        finished(
          paymentObservation({ charges: [chargeLeg({ refunds: [refund] })] }),
        ),
      );

      expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
        "resource_mismatch",
      );
    });
  }

  // Seen twice, the same money would be counted twice by anything adding the
  // reading up.
  test("calls the same charge named twice a problem", () => {
    const outcome = outcomeOf(
      finished(paymentObservation({ charges: [chargeLeg(), chargeLeg()] })),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "duplicate_charge",
    );
  });

  test("throws on a reading holding two refunds in flight", () => {
    // No M4 evidence can carry two pending refunds: the only pending refund a
    // reading holds is the answer to its own single attempt. The judge fails
    // loudly instead of letting broken evidence pass as settled.
    expect(() =>
      outcomeOf(
        finished(
          paymentObservation({
            charges: [
              chargeLeg({
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
            ],
          }),
        ),
      ),
    ).toThrow("more than one refund in flight");
  });

  test("calls a refund the provider could not finish a problem", () => {
    // Only a refund the provider actually tried and failed counts: the owner
    // has to be told, because the money is still with us and nothing else
    // will try again.
    const outcome = outcomeOf(
      finished(
        paymentObservation({
          charges: [
            chargeLeg({
              refunds: [
                refundObservation({
                  reason: "provider_failed",
                  status: "failed",
                }),
              ],
            }),
          ],
        }),
      ),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "failed_refund",
    );
  });

  test("calls a booking that asked for no money ready", () => {
    expect(outcomeOf(finished(noPaymentRequiredObservation())).kind).toBe(
      "ready",
    );
  });

  test("calls money taken on a booking that owed nothing a problem", () => {
    // Nothing was owed, so money arriving against it is money nobody asked
    // for and nobody can match to what was bought.
    const outcome = outcomeOf(
      finished(
        paymentObservation({
          charges: [chargeLeg()],
          expected: { amount: 0, currency: "GBP" },
          providerTotal: { amount: 100, currency: "GBP" },
          status: "paid",
        }),
      ),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "paid_without_charge",
    );
  });
});

// The evaluation order is part of the contract: a reading can match several
// kinds at once and exactly one is reported. These pin the order itself, not
// merely that each kind exists.
describe("which problem a reading is named by when several fit", () => {
  const secondLeg = { ...chargeResource, id: "pi_2" };
  const leg = (amount: number, resource = chargeResource) =>
    chargeLeg({ captured: { amount, currency: "GBP" }, resource });

  const orderCases: [name: string, charges: ChargeLeg[], expected: string][] = [
    [
      "two legs summing over the signed total",
      [leg(60), leg(60, secondLeg)],
      "capture_total_mismatch",
    ],
    [
      "two legs summing under the signed total",
      [leg(40), leg(40, secondLeg)],
      "partial_charge",
    ],
    [
      "two legs summing to the signed total",
      [leg(50), leg(50, secondLeg)],
      "multiple_charges",
    ],
    [
      "two legs summing to the signed total with money already back",
      [
        chargeLeg({
          captured: { amount: 50, currency: "GBP" },
          confirmedRefunded: { amount: 20, currency: "GBP" },
        }),
        leg(50, secondLeg),
      ],
      "partial_refund",
    ],
    [
      "two legs where only one gave its money back",
      [
        chargeLeg({
          captured: { amount: 50, currency: "GBP" },
          confirmedRefunded: { amount: 50, currency: "GBP" },
        }),
        leg(50, secondLeg),
      ],
      "partial_refund",
    ],
    [
      "more money back than was ever taken",
      [
        chargeLeg({
          confirmedRefunded: { amount: 150, currency: "GBP" },
        }),
      ],
      "refund_exceeds_capture",
    ],
    [
      "a leg taken in another currency",
      [
        chargeLeg({
          captured: { amount: 100, currency: "USD" },
          confirmedRefunded: { amount: 0, currency: "USD" },
        }),
      ],
      "currency_mismatch",
    ],
  ];

  for (const [name, charges, expected] of orderCases) {
    test(`names ${name} ${expected}`, () => {
      const outcome = outcomeOf(finished(paymentObservation({ charges })));

      expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
        expected,
      );
    });
  }

  // Two legs of one checkout, both given back: the money is gone, so this is
  // the refunded reading and not a leg-count problem.
  test("names two legs both given back fully refunded", () => {
    const given = (amount: number, resource = chargeResource) =>
      chargeLeg({
        captured: { amount, currency: "GBP" },
        confirmedRefunded: { amount, currency: "GBP" },
        resource,
      });

    expect(
      outcomeOf(
        finished(
          paymentObservation({ charges: [given(50), given(50, secondLeg)] }),
        ),
      ).kind,
    ).toBe("fully_refunded");
  });
});
