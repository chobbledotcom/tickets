import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  PaymentCharge,
  PaymentSession,
} from "#shared/db/payments/types.ts";
import {
  hasProvenBooking,
  type PaymentOperatorCase,
  paymentDecisionSelections,
} from "#shared/payment-runtime/operator-context.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import {
  legacyPaymentOperatorCase,
  provenPaymentOperatorCase,
} from "#test/shared/payment-runtime/fixtures.ts";
import { currentCharges } from "#test-utils/current-charge.ts";
import { required } from "#test-utils/required.ts";

type FoundRead = Extract<ProviderRead, { status: "found" }>;

const currentPayment = (context: PaymentOperatorCase): PaymentSession => {
  if (context.payment.origin !== "current") {
    throw new Error("Expected a current payment");
  }
  return context.payment.value;
};

const firstCharge = (context: PaymentOperatorCase): PaymentCharge =>
  required(currentCharges(context.charges)[0], "the payment's first charge");

const foundRead = (context: PaymentOperatorCase): FoundRead => {
  const evidence = context.case.evidence;
  if (!("kind" in evidence) || evidence.kind !== "provider_read") {
    throw new Error("Expected provider evidence");
  }
  if (evidence.read.status !== "found") {
    throw new Error("Expected found provider evidence");
  }
  return evidence.read;
};

describe("payment operator case rules", () => {
  test("accepts matching paid evidence as proof of the booking", () => {
    expect(hasProvenBooking(provenPaymentOperatorCase())).toBe(true);
  });

  const brokenProofs: ReadonlyArray<{
    breakProof: (context: PaymentOperatorCase) => void;
    name: string;
  }> = [
    {
      breakProof: (context) => {
        context.case.evidence = currentPayment(context).bookingIntent;
      },
      name: "booking evidence without a provider read",
    },
    {
      breakProof: (context) => {
        const requested = foundRead(context).requested;
        context.case.evidence = {
          kind: "provider_read",
          read: {
            reason: "not_found",
            requested,
            status: "missing",
          },
        };
      },
      name: "a missing provider read",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.status = "pending";
      },
      name: "an unpaid observation",
    },
    {
      breakProof: (context) => {
        context.charges = legacyPaymentOperatorCase().charges;
      },
      name: "a legacy charge",
    },
    {
      breakProof: (context) => {
        context.charges = [];
      },
      name: "no charges",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.charges = undefined;
      },
      name: "no observed charges",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.ownership.localPaymentId = "other";
      },
      name: "another local payment",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.accountId = "other";
      },
      name: "another account",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.mode = "live";
      },
      name: "another mode",
    },
    {
      breakProof: (context) => {
        const read = foundRead(context);
        read.observation.bookingIntent = {
          ...read.observation.bookingIntent,
          name: "Another buyer",
        };
      },
      name: "another booking",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.expected.amount = 999;
      },
      name: "another expected total",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.providerTotal.currency = "EUR";
      },
      name: "another provider currency",
    },
    {
      breakProof: (context) => {
        foundRead(context).observation.providerTotal.amount = 999;
      },
      name: "another provider total",
    },
    {
      breakProof: (context) => {
        firstCharge(context).captured.amount = 999;
      },
      name: "another captured total",
    },
    {
      breakProof: (context) => {
        firstCharge(context).captured.currency = "EUR";
      },
      name: "another captured currency",
    },
    {
      breakProof: (context) => {
        firstCharge(context).refunded.amount = 1;
      },
      name: "already refunded money",
    },
    {
      breakProof: (context) => {
        firstCharge(context).pendingRefund = {
          id: "pending-refund",
          kind: "stripe_refund",
          parentId: firstCharge(context).providerReference.id,
          provider: "stripe",
        };
      },
      name: "a pending refund",
    },
    {
      breakProof: (context) => {
        const observed = foundRead(context).observation.charges;
        if (observed === undefined) throw new Error("Expected observed charge");
        const charge = observed[0];
        if (charge === undefined) throw new Error("Expected observed charge");
        observed[0] = {
          ...charge,
          resource: { ...charge.resource, id: "other-charge" },
        };
      },
      name: "another observed charge",
    },
  ];

  for (const example of brokenProofs) {
    test(`rejects ${example.name} as booking proof`, () => {
      const context = provenPaymentOperatorCase();
      example.breakProof(context);
      expect(hasProvenBooking(context)).toBe(false);
    });
  }

  test("rejects a legacy payment as booking proof", () => {
    expect(hasProvenBooking(legacyPaymentOperatorCase())).toBe(false);
  });

  test("offers every safe current-payment choice", () => {
    const context = provenPaymentOperatorCase();
    context.case.reason = "partial_refund";

    expect(paymentDecisionSelections(context, [])).toEqual([
      { kind: "complete_booking" },
      { kind: "refund_remaining" },
      { kind: "confirm_fully_refunded" },
    ]);
  });

  for (const reason of [
    "partial_refund",
    "failed_refund",
    "legacy_refund_amount_unknown",
  ]) {
    test(`allows confirmation for ${reason}`, () => {
      const context = provenPaymentOperatorCase();
      context.case.reason = reason;
      firstCharge(context).refunded.amount = 1_000;

      expect(paymentDecisionSelections(context, [])).toEqual([
        { kind: "confirm_fully_refunded" },
      ]);
    });
  }

  test("does not offer refund confirmation for another case reason", () => {
    const context = provenPaymentOperatorCase();
    context.case.reason = "multiple_charges";
    firstCharge(context).refunded.amount = 1_000;

    expect(paymentDecisionSelections(context, [])).toEqual([]);
  });

  test("offers no action for a case that is not waiting for the owner", () => {
    const context = provenPaymentOperatorCase();
    context.case.state = "retrying";

    expect(paymentDecisionSelections(context, [])).toEqual([]);
  });

  test("offers no money action without current charges", () => {
    const context = provenPaymentOperatorCase();
    context.charges = [];

    expect(paymentDecisionSelections(context, [])).toEqual([]);
  });

  test("offers each configured account for an older payment", () => {
    expect(
      paymentDecisionSelections(legacyPaymentOperatorCase(), [
        { accountId: "square-account", mode: "test", provider: "square" },
        { accountId: "stripe-account", mode: "live", provider: "stripe" },
      ]),
    ).toEqual([
      {
        accountId: "square-account",
        kind: "assign_provider",
        mode: "test",
        provider: "square",
      },
      {
        accountId: "stripe-account",
        kind: "assign_provider",
        mode: "live",
        provider: "stripe",
      },
    ]);
  });

  test("offers only the distinct keep choice after an older charge is typed", () => {
    const context = legacyPaymentOperatorCase();
    context.charges = provenPaymentOperatorCase().charges;
    context.case.reason = "partial_refund";

    expect(paymentDecisionSelections(context, [])).toEqual([
      { kind: "keep_legacy_payment" },
    ]);
  });

  test("does not offer assignment without a usable provider reference", () => {
    const context = legacyPaymentOperatorCase();
    if (context.payment.origin !== "legacy") throw new Error("Expected legacy");
    context.payment.value.runtime.attendeePayment = null;

    expect(
      paymentDecisionSelections(context, [
        {
          accountId: "square-account",
          mode: "test",
          provider: "square",
        },
      ]),
    ).toEqual([]);
  });

  test("does not offer the provider already assigned to an older payment", () => {
    const context = legacyPaymentOperatorCase();
    if (context.payment.origin !== "legacy") throw new Error("Expected legacy");
    context.payment.value.provider = "square";

    expect(
      paymentDecisionSelections(context, [
        {
          accountId: "square-account",
          mode: "test",
          provider: "square",
        },
      ]),
    ).toEqual([]);
  });
});
