import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentChargeDecisionSnapshotSchema,
  PaymentLegacyDecisionSnapshotSchema,
  PaymentOperatorDecisionSchema,
  PaymentOperatorSelectionSchema,
} from "#shared/payment-state/decision.ts";

describe("what an owner's decision may be", () => {
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

  test("refuses giving a payment one provider while showing another's money", () => {
    // The owner is saying which provider took this old payment, so being shown
    // a different provider's checkout would attach the wrong money.
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        accountId: "acct_1",
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "assign_provider",
        mode: "test",
        provider: "square",
        read: {
          captured: { amount: 100, currency: "GBP" },
          charge: {
            id: "pi_1",
            kind: "stripe_payment_intent",
            parentId: "cs_1",
            provider: "stripe",
          },
          refunded: { amount: 0, currency: "GBP" },
          session: {
            id: "cs_1",
            kind: "stripe_checkout_session",
            provider: "stripe",
          },
          status: "attached",
        },
        reason: "It was Stripe",
      }).success,
    ).toBe(false);
  });

  test("requires a reason, actor, and current case revision for decisions", () => {
    const base = {
      actorId: 1,
      caseRevision: 1,
      decidedAt: 1_785_024_000_000,
      reason: "Provider evidence checked",
    };
    const decisions = [
      { ...base, kind: "complete_booking" },
      { ...base, kind: "refund_remaining" },
      {
        ...base,
        charges: [
          { captured: { amount: 1_000, currency: "GBP" }, chargeId: 1 },
        ],
        kind: "confirm_fully_refunded",
      },
      {
        ...base,
        accountId: "account_1",
        kind: "assign_provider",
        mode: "live",
        provider: "square",
        read: { status: "missing" },
      },
    ] as const;
    expect(
      decisions.map(
        (item) => v.parse(PaymentOperatorDecisionSchema, item).kind,
      ),
    ).toEqual([
      "complete_booking",
      "refund_remaining",
      "confirm_fully_refunded",
      "assign_provider",
    ]);
  });

  for (const [name, decision] of [
    [
      "generic dismissal",
      {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "dismiss",
        reason: "Ignore it",
      },
    ],
    [
      "stale revision",
      {
        actorId: 1,
        caseRevision: 0,
        decidedAt: 1,
        kind: "refund_remaining",
        reason: "Refund it",
      },
    ],
    [
      "empty reason",
      {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "complete_booking",
        reason: "",
      },
    ],
  ] as const) {
    test(`rejects an operator decision with ${name}`, () => {
      expect(v.safeParse(PaymentOperatorDecisionSchema, decision).success).toBe(
        false,
      );
    });
  }

  // Each choice is stored and later read back by name, so the words
  // themselves are the contract: a worker looks up what to do by this exact
  // string. One renamed and nothing would match it again.
  for (const kind of [
    "complete_booking",
    "refund_remaining",
    "confirm_fully_refunded",
    "keep_legacy_payment",
  ] as const) {
    test(`accepts the owner choosing ${kind}`, () => {
      expect(
        v.safeParse(PaymentOperatorSelectionSchema, { kind }).success,
      ).toBe(true);
    });
  }

  test("accepts the owner giving an old payment a provider", () => {
    expect(
      v.safeParse(PaymentOperatorSelectionSchema, {
        accountId: "acct_1",
        kind: "assign_provider",
        mode: "test",
        provider: "stripe",
      }).success,
    ).toBe(true);
  });

  test("refuses a choice nobody offers", () => {
    expect(
      v.safeParse(PaymentOperatorSelectionSchema, { kind: "do_something_else" })
        .success,
    ).toBe(false);
  });

  // Every one of these counts from one: there is no actor nought, no version
  // nought, and no charge nought for a decision to be about.
  for (const [name, field] of [
    ["the person who decided", "actorId"],
    ["the version they decided on", "caseRevision"],
  ] as const) {
    test(`refuses a decision numbering ${name} as nothing`, () => {
      expect(
        v.safeParse(PaymentOperatorDecisionSchema, {
          actorId: 1,
          caseRevision: 1,
          decidedAt: 1,
          kind: "complete_booking",
          reason: "Checked",
          [field]: 0,
        }).success,
      ).toBe(false);
    });
  }

  test("accepts a decision made at the very start of the clock", () => {
    // Times count from the epoch, so nought is a real moment. Floored at one,
    // the earliest a site could record would be refused.
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 0,
        kind: "complete_booking",
        reason: "Checked",
      }).success,
    ).toBe(true);
  });

  test("refuses confirming money against a charge numbered nothing", () => {
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        actorId: 1,
        caseRevision: 1,
        charges: [{ captured: { amount: 100, currency: "GBP" }, chargeId: 0 }],
        decidedAt: 1,
        kind: "confirm_fully_refunded",
        reason: "Checked",
      }).success,
    ).toBe(false);
  });

  // The wording is what an operator is shown when a decision will not save, so
  // each one is pinned rather than left to say anything at all.
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

  test("says what is wrong with a provider that does not match its money", () => {
    const result = v.safeParse(PaymentOperatorDecisionSchema, {
      accountId: "acct_1",
      actorId: 1,
      caseRevision: 1,
      decidedAt: 1,
      kind: "assign_provider",
      mode: "test",
      provider: "stripe",
      read: {
        captured: { amount: 100, currency: "GBP" },
        charge: {
          id: "sq_1",
          kind: "square_payment",
          parentId: "order_1",
          provider: "square",
        },
        refunded: { amount: 0, currency: "GBP" },
        session: {
          id: "order_1",
          kind: "square_order",
          provider: "square",
        },
        status: "attached",
      },
      reason: "Checked",
    });

    expect(result.issues?.map((issue) => issue.message)).toContain(
      "The money shown must come from the provider being given to the payment",
    );
  });

  // A review with no money in it shows the owner nothing to decide about, so
  // every list of reviewed money has to hold at least one row.
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

  test("refuses confirming a refund against no money at all", () => {
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        actorId: 1,
        caseRevision: 1,
        charges: [],
        decidedAt: 1,
        kind: "confirm_fully_refunded",
        reason: "Checked",
      }).success,
    ).toBe(false);
  });

  test("refuses an old payment's review of a charge numbered nothing", () => {
    expect(
      v.safeParse(PaymentLegacyDecisionSnapshotSchema, {
        charges: [{ chargeId: 0, providerReference: "ch_old" }],
        kind: "legacy_assignment",
        paymentId: "pay_1",
      }).success,
    ).toBe(false);
  });

  test("accepts the owner deciding to leave an old payment alone", () => {
    // The plainest decision of the five, and the only one carrying nothing but
    // who decided and why.
    expect(
      v.parse(PaymentOperatorDecisionSchema, {
        actorId: 1,
        caseRevision: 1,
        decidedAt: 1,
        kind: "keep_legacy_payment",
        reason: "Nothing to do",
      }).kind,
    ).toBe("keep_legacy_payment");
  });

  test("rejects confirming the same charge twice", () => {
    // Two entries for one charge are two different accounts of the money the
    // owner just confirmed, and anything adding the list up counts it twice.
    expect(
      v.safeParse(PaymentOperatorDecisionSchema, {
        actorId: 1,
        caseRevision: 1,
        charges: [
          { captured: { amount: 1_000, currency: "GBP" }, chargeId: 1 },
          { captured: { amount: 2_500, currency: "GBP" }, chargeId: 1 },
        ],
        decidedAt: 1,
        kind: "confirm_fully_refunded",
        reason: "Provider evidence checked",
      }).success,
    ).toBe(false);
  });
});
