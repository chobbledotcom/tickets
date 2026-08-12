import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  admissionReason,
  admitObservedRefund,
  admitProviderRefund,
  admitRefund,
  sendRefundIfAdmitted,
} from "#shared/payment/admit-refund.ts";
import type { ObservationOutcome } from "#shared/payment/diagnose.ts";
import { refundOutcomeOf } from "#shared/payment/diagnose.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { ResolvedRefundCapability } from "#shared/payment/row-state.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import {
  chargeMoneyWith,
  gbp,
  partlyRefundedCharge,
  refundObservation,
  unreadChargeCases,
} from "#test-utils/payment-state.ts";

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

describe("why money was not sent", () => {
  for (const [name, admission, expected] of [
    [
      "money already returned",
      { kind: "already_returned" },
      "the money is already back",
    ],
    [
      "a refund underway",
      { kind: "in_flight" },
      "a refund is already on its way",
    ],
    [
      "a missing provider charge",
      { kind: "read_failed", read: { status: "missing" } },
      "the provider says the charge does not exist",
    ],
    [
      "an unavailable provider",
      {
        kind: "read_failed",
        read: { reason: "timeout", status: "unavailable" },
      },
      "the provider could not answer (timeout)",
    ],
    [
      "invalid provider data",
      {
        kind: "read_failed",
        read: { reason: "malformed_money", status: "invalid" },
      },
      "the provider returned invalid data (malformed_money)",
    ],
    [
      "a conflict needing owner review",
      { issue: { kind: "partial_refund" }, kind: "refused" },
      "needs the owner to look at it (partial_refund)",
    ],
  ] as const satisfies readonly (readonly [
    string,
    Parameters<typeof admissionReason>[0],
    string,
  ])[]) {
    test(`explains ${name}`, () => {
      expect(admissionReason(admission)).toBe(expected);
    });
  }
});

describe("provider evidence before a refund", () => {
  const completed: RefundAttemptResult = {
    amount: gbp(100),
    kind: "completed",
    proof: {
      kind: "named_refund",
      refund: {
        id: "re_1",
        kind: "stripe_refund",
        parentId: "pi_1",
        provider: "stripe",
      },
    },
  };

  const provider = (
    readCharge: PaymentProvider["readCharge"],
    refundCapability: ResolvedRefundCapability = "keyed",
    result: RefundAttemptResult = completed,
  ) => {
    const refundCharge = spy(() => Promise.resolve(result));
    return { readCharge, refundCapability, refundCharge };
  };

  for (const [name, read] of unreadChargeCases) {
    test(`keeps a ${name} read distinct`, async () => {
      const source = provider(() => Promise.resolve(read));
      expect(await admitProviderRefund(source, "pi_1")).toEqual({
        kind: "read_failed",
        read,
      });
      expect(source.refundCharge.calls).toHaveLength(0);
      expect(await sendRefundIfAdmitted(source, "pi_1")).toEqual({
        admission: { kind: "read_failed", read },
        kind: "withheld",
      });
      expect(source.refundCharge.calls).toHaveLength(0);
    });
  }

  test("sends the exact observed charge to the provider", async () => {
    const charge = chargeMoneyWith();
    const source = provider(() =>
      Promise.resolve({ resource: charge, status: "found" }),
    );

    expect(await sendRefundIfAdmitted(source, "pi_1")).toEqual(completed);
    expect(source.refundCharge.calls).toHaveLength(1);
    expect(source.refundCharge.calls[0]?.args).toEqual([
      {
        charge,
        paymentReference: "pi_1",
      },
    ]);
  });

  test("admits an existing validated reading without another provider read", () => {
    const charge = chargeMoneyWith();

    expect(admitObservedRefund("pi_1", charge)).toEqual({
      kind: "send",
      request: { charge, paymentReference: "pi_1" },
    });
  });

  test("returns an accepted attempt without calling it completed", async () => {
    const accepted: RefundAttemptResult = {
      amount: gbp(100),
      kind: "accepted",
      proof: completed.proof,
    };
    const source = provider(
      () => Promise.resolve({ resource: chargeMoneyWith(), status: "found" }),
      "keyed",
      accepted,
    );

    expect(await sendRefundIfAdmitted(source, "pi_1")).toEqual(accepted);
  });
});
