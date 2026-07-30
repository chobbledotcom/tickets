import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentChargeDecisionSnapshotSchema,
  PaymentLegacyDecisionSnapshotSchema,
} from "#shared/payment-state/decision.ts";

describe("the written-down review a decision is made from", () => {
  test("refuses reviewed money taken by another provider", () => {
    // The worker acts through the provider the decision names, so being shown
    // another provider's money would have it act on the wrong account.
    expect(
      v.safeParse(PaymentChargeDecisionSnapshotSchema, {
        accountId: "acct_1",
        charges: [
          {
            captured: { amount: 100, currency: "GBP" },
            chargeId: 1,
            providerReference: {
              id: "sq_1",
              kind: "square_payment",
              parentId: "order_1",
              provider: "square",
            },
            refunded: { amount: 0, currency: "GBP" },
          },
        ],
        kind: "charges",
        mode: "test",
        paymentId: "pay_1",
        provider: "stripe",
      }).success,
    ).toBe(false);
  });

  const chargeSnapshot = (charges: unknown[]) => ({
    accountId: "acct_1",
    charges,
    kind: "charges",
    mode: "test",
    paymentId: "pay_1",
    provider: "stripe",
  });

  const squareReference = {
    id: "sq_1",
    kind: "square_payment",
    parentId: "order_1",
    provider: "square",
  };

  const reviewedCharge = {
    captured: { amount: 100, currency: "GBP" },
    chargeId: 1,
    providerReference: {
      id: "pi_1",
      kind: "stripe_payment_intent",
      parentId: "cs_1",
      provider: "stripe",
    },
    refunded: { amount: 0, currency: "GBP" },
  };

  for (const [name, broken] of [
    [
      "returned beyond what was taken",
      { refunded: { amount: 101, currency: "GBP" } },
    ],
    [
      "returned in another currency",
      { refunded: { amount: 0, currency: "USD" } },
    ],
    // A charge row must hold at least a penny, so a review of nothing shows
    // the worker money that could never be saved as the charge it names.
    ["no money taken at all", { captured: { amount: 0, currency: "GBP" } }],
  ] as const) {
    test(`refuses reviewed money ${name}`, () => {
      expect(
        v.safeParse(
          PaymentChargeDecisionSnapshotSchema,
          chargeSnapshot([{ ...reviewedCharge, ...broken }]),
        ).success,
      ).toBe(false);
    });
  }

  test("refuses the same money listed twice in a review", () => {
    // Listed twice, it would be offered to the worker twice.
    expect(
      v.safeParse(
        PaymentChargeDecisionSnapshotSchema,
        chargeSnapshot([reviewedCharge, reviewedCharge]),
      ).success,
    ).toBe(false);
  });

  test("refuses two rows in a review naming the provider's same money", () => {
    // Different rows, one payment at the provider: the second row would let
    // the same money be acted on twice under another name.
    expect(
      v.safeParse(
        PaymentChargeDecisionSnapshotSchema,
        chargeSnapshot([reviewedCharge, { ...reviewedCharge, chargeId: 2 }]),
      ).success,
    ).toBe(false);
  });

  // An old payment's review names its money as plain text, so the same two
  // holes have to be closed there as well.
  for (const [name, charges] of [
    [
      "lists the same money twice",
      [
        { chargeId: 1, providerReference: "ch_old" },
        { chargeId: 1, providerReference: "ch_old" },
      ],
    ],
    [
      "names the same old money under two rows",
      [
        { chargeId: 1, providerReference: "ch_old" },
        { chargeId: 2, providerReference: "ch_old" },
      ],
    ],
    [
      "names money with only spaces",
      [{ chargeId: 1, providerReference: "   " }],
    ],
  ] as const) {
    test(`refuses an old payment's review that ${name}`, () => {
      expect(
        v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
          charges,
          kind: "legacy_assignment",
          paymentId: "pay_1",
        }).success,
      ).toBe(false);
    });
  }

  test("accepts an old payment's review naming distinct money", () => {
    expect(
      v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
        charges: [
          { chargeId: 1, providerReference: "ch_old" },
          { chargeId: 2, providerReference: "ch_older" },
        ],
        kind: "legacy_assignment",
        paymentId: "pay_1",
      }).success,
    ).toBe(true);
  });

  for (const [name, broken, message] of [
    [
      "a review naming another provider's money",
      chargeSnapshot([
        { ...reviewedCharge, providerReference: squareReference },
      ]),
      "Reviewed money must come from the provider the decision names",
    ],
    [
      "a review listing one charge twice",
      chargeSnapshot([reviewedCharge, reviewedCharge]),
      "Reviewed money must not list the same charge twice",
    ],
    [
      "a review giving back more than was taken",
      chargeSnapshot([
        { ...reviewedCharge, refunded: { amount: 500, currency: "GBP" } },
      ]),
      "Money returned must fit inside the money taken, in the same currency",
    ],
  ] as const) {
    test(`says what is wrong with ${name}`, () => {
      const result = v.safeParse(PaymentChargeDecisionSnapshotSchema, broken);

      expect(result.issues?.map((issue) => issue.message)).toContain(message);
    });
  }

  for (const [name, empty] of [
    ["a current payment's review", chargeSnapshot([])],
    [
      "an old payment's review",
      { charges: [], kind: "legacy_assignment", paymentId: "pay_1" },
    ],
  ] as const) {
    test(`refuses ${name} showing no money at all`, () => {
      const schema =
        "provider" in empty
          ? PaymentChargeDecisionSnapshotSchema
          : PaymentLegacyDecisionSnapshotSchema;

      expect(v.safeParse(schema, empty).success).toBe(false);
    });
  }

  test("refuses an old payment's review of a charge numbered nothing", () => {
    expect(
      v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
        charges: [{ chargeId: 0, providerReference: "ch_old" }],
        kind: "legacy_assignment",
        paymentId: "pay_1",
      }).success,
    ).toBe(false);
  });
});
