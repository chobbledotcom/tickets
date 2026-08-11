import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { WithheldRefund } from "#shared/payment/admit-refund.ts";
import {
  admitRefund,
  sendRefundIfAdmitted,
} from "#shared/payment/admit-refund.ts";
import type { ObservationOutcome } from "#shared/payment/diagnose.ts";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { chargeMoneyWith, gbp, partlyRefundedCharge, refundObservation } from "#test-utils/payment-state.ts";

/** Money back on every penny of this charge. */
const fullyRefundedCharge = (): ChargeMoney =>
  chargeMoneyWith({
    confirmedRefunded: gbp(100),
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
    ["an untouched charge", [chargeMoneyWith()], "send"],
    [
      "a charge already given back",
      [fullyRefundedCharge()],
      "already_returned",
    ],
    [
      "a charge with money on its way back",
      [
        chargeMoneyWith({
          refunds: [refundObservation({ status: "pending" })],
        }),
      ],
      "in_flight",
    ],
    ["a part-refunded charge", [partlyRefundedCharge()], "refused"],
    [
      "a charge that gave back more than it took",
      [
        chargeMoneyWith({
          confirmedRefunded: gbp(140),
        }),
      ],
      "refused",
    ],
    [
      "one charge back and one not",
      [fullyRefundedCharge(), chargeMoneyWith()],
      "refused",
    ],
  ] as const satisfies readonly (readonly [
    string,
    readonly ChargeMoney[],
    string,
  ])[]) {
    test(`answers ${expected} for ${name}`, () => {
      expect(admitRefund(refundOutcomeOf([...charges])).kind).toBe(expected);
    });
  }
});

describe("a charge the provider cannot state", () => {
  /** A provider whose numbers come back unusable, which is the very thing the
   *  rejected-charge recovery exists to deal with. */
  const cannotState = (refundCapability: RefundCapability) => ({
    readChargeMoneyOrNull: () => Promise.resolve(null),
    refundCapability,
    refundPayment: () => Promise.resolve(true),
  });

  const answer = {
    failed: () => "failed",
    sent: () => "sent",
    withhold: (admission: WithheldRefund) => admission.kind,
  };

  test("is withheld by default, because nobody can say what its money did", async () => {
    expect(
      await sendRefundIfAdmitted(cannotState("keyed"), "pi_1", answer),
    ).toBe("unreadable");
  });

  // The recovery path only exists because the charge's numbers came back
  // unusable, so asking the guard to read them asks the question that already
  // failed. A keyed provider rejects a second full refund itself, so trying
  // costs nothing — and refusing would leave the buyer charged for good.
  test("is sent by the recovery path when a repeat would be harmless", async () => {
    expect(
      await sendRefundIfAdmitted(cannotState("keyed"), "pi_1", answer, true),
    ).toBe("sent");
  });

  // SumUp has no idempotency key, so a repeat is a second payout. Being unable
  // to read the charge means we cannot rule that out, so it still withholds.
  for (const capability of ["keyless", "unresolved"] as const) {
    test(`is still withheld for a ${capability} provider`, async () => {
      expect(
        await sendRefundIfAdmitted(
          cannotState(capability),
          "pi_1",
          answer,
          true,
        ),
      ).toBe("unreadable");
    });
  }
});
