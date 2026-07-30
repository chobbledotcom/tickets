import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  PaymentOperatorDecisionSchema,
  PaymentOperatorSelectionSchema,
} from "#shared/payment-state/decision.ts";

describe("what an owner's decision may be", () => {
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
