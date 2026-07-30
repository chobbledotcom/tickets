import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import type { SettledReading } from "#shared/payment-state/diagnose.ts";
import { hasSettled, outcomeOf } from "#shared/payment-state/diagnose.ts";
import { PaymentResolutionSchema } from "#shared/payment-state/lifecycle.ts";
import type { PaymentObservation } from "#shared/payment-state/observation.ts";
import {
  chargeLeg,
  noPaymentRequiredObservation,
  partlyRefundedCharge,
  paymentObservation,
  refundObservation,
  refundResource,
  sessionResource,
} from "./fixtures.ts";

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

  // Every answer asks the same shared judgement, so an answer cannot say the
  // money is settled while the resolver would call the same reading a problem.
  for (const [name, observation] of [
    [
      "a total the provider disagrees with",
      paymentObservation({ providerTotal: { amount: 99, currency: "GBP" } }),
    ],
    [
      "money taken in a different currency",
      paymentObservation({ providerTotal: { amount: 100, currency: "USD" } }),
    ],
    [
      "a charge belonging to another checkout",
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
      expect(() =>
        v.parse(PaymentResolutionSchema, { observation, status: "ready" }),
      ).toThrow();
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

  test("calls the same refund named twice a problem", () => {
    const outcome = outcomeOf(
      finished(
        paymentObservation({
          charges: [
            chargeLeg({
              confirmedRefunded: { amount: 100, currency: "GBP" },
              // Half each, so only the repeated id is wrong with this reading.
              refunds: [
                refundObservation({ amount: { amount: 50, currency: "GBP" } }),
                refundObservation({ amount: { amount: 50, currency: "GBP" } }),
              ],
            }),
          ],
        }),
      ),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "duplicate_refund",
    );
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
          charges: [chargeLeg({ captured: { amount: 0, currency: "GBP" } })],
          expected: { amount: 0, currency: "GBP" },
          providerTotal: { amount: 0, currency: "GBP" },
          status: "no_payment_required",
        }),
      ),
    );

    expect(outcome.kind === "conflict" ? outcome.issue.kind : undefined).toBe(
      "paid_without_charge",
    );
  });

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
