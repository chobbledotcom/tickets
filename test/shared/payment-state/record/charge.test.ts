import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  chargeKnowsWhereItCameFrom,
  type StoredCharge,
} from "#shared/payment-state/record/charge.ts";

const takenHere: StoredCharge = {
  capturedAmount: 100,
  currency: "GBP",
  legacySource: null,
  origin: "current",
  pendingRefundId: null,
  pendingRefundIdempotencyKey: null,
  pendingRefundIndex: null,
  pendingRefundKeyIndex: null,
  provider: "stripe",
  providerRefundedAt: null,
  referenceIndex: "idx",
  refundedAmount: 0,
  refundState: "none",
  resourceKind: "stripe_payment_intent",
};

const copiedAcross: StoredCharge = {
  ...takenHere,
  capturedAmount: null,
  currency: null,
  legacySource: "processed_payments",
  origin: "legacy",
  provider: null,
  providerRefundedAt: 1750000000000,
  referenceIndex: null,
  refundedAmount: null,
  refundState: "unknown",
  resourceKind: null,
};

describe("what a stored charge may be", () => {
  test("accepts money taken here and money copied across", () => {
    expect(chargeKnowsWhereItCameFrom(takenHere)).toBe(null);
    expect(chargeKnowsWhereItCameFrom(copiedAcross)).toBe(null);
  });

  for (const [name, broken] of [
    ["it names no provider", { provider: null }],
    ["it has no refunded total", { refundedAmount: null }],
    ["it has no way to be found again", { referenceIndex: null }],
    ["it carries an old record's refund time", { providerRefundedAt: 1 }],
    [
      "it says where it was copied from",
      { legacySource: "processed_payments" },
    ],
    ["it says its refund is unknown", { refundState: "unknown" as const }],
  ] as const) {
    test(`refuses money taken here when ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...takenHere, ...broken })).not.toBe(
        null,
      );
    });
  }

  for (const [name, broken] of [
    ["it invents an amount", { capturedAmount: 100 }],
    ["it invents a provider", { provider: "stripe" }],
    ["it does not say where it came from", { legacySource: null }],
    ["it came from nowhere at all", { legacySource: "" }],
    ["it came from a table we never had", { legacySource: "made_up" }],
    [
      "it claims to know how its refund went",
      { refundState: "completed" as const },
    ],
  ] as const) {
    test(`refuses money copied across when ${name}`, () => {
      expect(
        chargeKnowsWhereItCameFrom({ ...copiedAcross, ...broken }),
      ).not.toBe(null);
    });
  }

  // A refund still going is the open case: it may have been started in the
  // provider's own dashboard, so neither handle need be held.
  for (const [name, broken, allowed] of [
    [
      "a refund asked for keeps its key",
      {
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundState: "requested" as const,
      },
      true,
    ],
    [
      "a refund asked for already names the provider's refund",
      {
        pendingRefundId: "enc:1:a:b",
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundState: "requested" as const,
      },
      false,
    ],
    [
      "a refund asked for keeps no key at all",
      { refundState: "requested" as const },
      false,
    ],
    [
      "a refund still going holds neither handle",
      { refundedAmount: 0, refundState: "pending" as const },
      true,
    ],
    [
      "a settled charge still holds a handle",
      { pendingRefundId: "enc:1:a:b" },
      false,
    ],
  ] as const) {
    test(`${allowed ? "accepts" : "refuses"} a charge where ${name}`, () => {
      const answer = chargeKnowsWhereItCameFrom({ ...takenHere, ...broken });
      expect(answer === null).toBe(allowed);
    });
  }

  for (const [name, broken] of [
    [
      "nothing is left to give back",
      {
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundedAmount: 100,
        refundState: "requested" as const,
      },
    ],
    ["it says no refund but money has gone back", { refundedAmount: 50 }],
    [
      "a part refund gave everything back",
      { refundedAmount: 100, refundState: "partial" as const },
    ],
    [
      "a finished refund gave only some back",
      { refundedAmount: 50, refundState: "completed" as const },
    ],
  ] as const) {
    test(`refuses a charge where ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...takenHere, ...broken })).not.toBe(
        null,
      );
    });
  }
});

describe("refund handles a charge may hold", () => {
  test("refuses a failed refund still naming a refund in progress", () => {
    expect(
      chargeKnowsWhereItCameFrom({
        ...takenHere,
        pendingRefundId: "enc:1:a:b",
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundState: "failed",
      }),
    ).not.toBe(null);
  });

  test("accepts a failed refund that holds no refund in progress", () => {
    expect(
      chargeKnowsWhereItCameFrom({ ...takenHere, refundState: "failed" }),
    ).toBe(null);
  });
});
