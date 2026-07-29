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

  // Each case names the one thing that is wrong, so a rule cannot quietly stop
  // saying it — and a failure here points at the rule that broke.
  const KNOWS_ITSELF =
    "Money taken here knows who took it, how much, and how to find it again";
  const NO_OLD_DETAILS =
    "Money taken here cannot carry an old record's details";

  for (const [name, broken, fault] of [
    ["it names no provider", { provider: null }, KNOWS_ITSELF],
    ["it has no refunded total", { refundedAmount: null }, KNOWS_ITSELF],
    ["it has no way to be found again", { referenceIndex: null }, KNOWS_ITSELF],
    [
      "it carries an old record's refund time",
      { providerRefundedAt: 1 },
      NO_OLD_DETAILS,
    ],
    [
      "it says where it was copied from",
      { legacySource: "processed_payments" },
      NO_OLD_DETAILS,
    ],
    [
      "it says its refund is unknown",
      { refundState: "unknown" as const },
      `Only money copied across may say its refund is "unknown"`,
    ],
  ] as const) {
    test(`refuses money taken here when ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...takenHere, ...broken })).toBe(
        fault,
      );
    });
  }

  const KNOWS_NOTHING_MORE =
    "Money copied across knows only that it happened, nothing more";
  const SAYS_WHERE_FROM =
    "Money copied across must say which old table it came from";

  for (const [name, broken, fault] of [
    ["it invents an amount", { capturedAmount: 100 }, KNOWS_NOTHING_MORE],
    ["it invents a provider", { provider: "stripe" }, KNOWS_NOTHING_MORE],
    [
      "it does not say where it came from",
      { legacySource: null },
      SAYS_WHERE_FROM,
    ],
    ["it came from nowhere at all", { legacySource: "" }, SAYS_WHERE_FROM],
    [
      "it came from a table we never had",
      { legacySource: "made_up" },
      SAYS_WHERE_FROM,
    ],
    [
      "it claims to know how its refund went",
      { refundState: "completed" as const },
      "Money copied across never said what became of its refund",
    ],
  ] as const) {
    test(`refuses money copied across when ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...copiedAcross, ...broken })).toBe(
        fault,
      );
    });
  }

  test("accepts a part refund of a single penny", () => {
    // The smallest a part refund can be: any of it back, but not all of it.
    expect(
      chargeKnowsWhereItCameFrom({
        ...takenHere,
        refundedAmount: 1,
        refundState: "partial",
      }),
    ).toBe(null);
  });

  // A refund still going is the open case: it may have been started in the
  // provider's own dashboard, so neither handle need be held.
  for (const [name, broken, fault] of [
    [
      "a refund asked for keeps its key",
      {
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundState: "requested" as const,
      },
      null,
    ],
    [
      "a refund asked for already names the provider's refund",
      {
        pendingRefundId: "enc:1:a:b",
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundState: "requested" as const,
      },
      "A refund only asked for cannot already name the provider's refund",
    ],
    [
      "a refund asked for keeps no key at all",
      { refundState: "requested" as const },
      "A refund asked for must keep the key that stops it being asked twice",
    ],
    [
      "a refund still going holds neither handle",
      { refundedAmount: 0, refundState: "pending" as const },
      null,
    ],
    [
      "a settled charge still holds a handle",
      { pendingRefundId: "enc:1:a:b" },
      "A charge with no refund in progress cannot hold a refund's handles",
    ],
    [
      "a failed refund still names a refund in progress",
      { pendingRefundId: "enc:1:a:b", refundState: "failed" as const },
      "A refund that failed cannot still name a refund in progress",
    ],
  ] as const) {
    test(`${fault === null ? "accepts" : "refuses"} a charge where ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...takenHere, ...broken })).toBe(
        fault,
      );
    });
  }

  for (const [name, broken, fault] of [
    [
      "nothing is left to give back",
      {
        pendingRefundIdempotencyKey: "enc:1:a:b",
        refundedAmount: 100,
        refundState: "requested" as const,
      },
      "A refund still being asked for cannot already claim everything taken",
    ],
    [
      "it says no refund but money has gone back",
      { refundedAmount: 50 },
      "A charge with no refund cannot have money already gone back",
    ],
    [
      "a part refund gave everything back",
      { refundedAmount: 100, refundState: "partial" as const },
      "A part refund must have given back some of the money, but not all",
    ],
    [
      "a part refund gave nothing back",
      { refundedAmount: 0, refundState: "partial" as const },
      "A part refund must have given back some of the money, but not all",
    ],
    [
      "a failed refund says more came back than was taken",
      { refundedAmount: 150, refundState: "failed" as const },
      "A refund that failed cannot have given back more than was taken",
    ],
    [
      "a finished refund gave only some back",
      { refundedAmount: 50, refundState: "completed" as const },
      "A finished refund must have given back everything taken",
    ],
    [
      "a refund still going already claims everything taken",
      { refundedAmount: 100, refundState: "pending" as const },
      "A refund still being asked for cannot already claim everything taken",
    ],
  ] as const) {
    test(`refuses a charge where ${name}`, () => {
      expect(chargeKnowsWhereItCameFrom({ ...takenHere, ...broken })).toBe(
        fault,
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
