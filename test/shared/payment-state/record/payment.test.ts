import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  paymentKnowsWhereItCameFrom,
  readyToClearBuyerDetails,
  type StoredPayment,
} from "#shared/payment-state/record/payment.ts";

/** A payment made here, with nothing wrong with it. */
const madeHere: StoredPayment = {
  accountId: "acct",
  bookingIntent: "enc:1:a:b",
  checkoutCreate: null,
  completion: null,
  completionState: "none",
  expectedAmount: 100,
  expectedCurrency: "GBP",
  leaseToken: null,
  legacyRuntime: null,
  mode: "test",
  nextReconcileAt: null,
  origin: "current",
  provider: "stripe",
  result: null,
  resultState: "none",
  sessionReferenceIndex: "idx",
  sessionResource: "enc:1:a:b",
  state: "pending",
  ticketState: "none",
  ticketTokens: null,
};

/** The same payment, copied across when the site upgraded. */
const copiedPayment: StoredPayment = {
  ...madeHere,
  accountId: null,
  bookingIntent: null,
  expectedAmount: null,
  expectedCurrency: null,
  legacyRuntime: "enc:1:a:b",
  mode: null,
  origin: "legacy",
  provider: null,
  sessionReferenceIndex: null,
  sessionResource: null,
  state: "completed",
};

describe("what a stored payment may be", () => {
  test("accepts a payment made here and one copied across", () => {
    expect(paymentKnowsWhereItCameFrom(madeHere)).toBe(null);
    expect(paymentKnowsWhereItCameFrom(copiedPayment)).toBe(null);
  });

  for (const [name, broken] of [
    ["it knows nothing about the money", { expectedAmount: null }],
    ["it names no account", { accountId: null }],
    ["it carries an old payment's record", { legacyRuntime: "enc:1:a:b" }],
    [
      "it is past its start with no checkout",
      { sessionReferenceIndex: null, sessionResource: null },
    ],
    [
      "it still holds what the provider was asked to build",
      { checkoutCreate: "enc:1:a:b" },
    ],
    [
      "it says it has a result but keeps none",
      { resultState: "succeeded" as const },
    ],
    [
      "its tickets are ready but it has none",
      { ticketState: "ready" as const },
    ],
    [
      "work is still to do with nothing booked",
      { completion: "enc:1:a:b", completionState: "pending" as const },
    ],
    [
      "it has work nobody knows about",
      { completion: "enc:1:a:b", completionState: "legacy_unknown" as const },
    ],
  ] as const) {
    test(`refuses a payment made here when ${name}`, () => {
      expect(paymentKnowsWhereItCameFrom({ ...madeHere, ...broken })).not.toBe(
        null,
      );
    });
  }

  for (const [name, broken] of [
    ["it keeps no old record", { legacyRuntime: null }],
    ["it knows what was being bought", { bookingIntent: "enc:1:a:b" }],
    [
      "it succeeded without completing",
      { resultState: "succeeded" as const, state: "failed" as const },
    ],
    [
      "work nobody knows about on an unfinished payment",
      { completionState: "legacy_unknown" as const, state: "failed" as const },
    ],
  ] as const) {
    test(`refuses a payment copied across when ${name}`, () => {
      expect(
        paymentKnowsWhereItCameFrom({ ...copiedPayment, ...broken }),
      ).not.toBe(null);
    });
  }
});

describe("how a copied payment turned out", () => {
  for (const [name, broken, allowed] of [
    ["it says nothing and kept nothing", {}, true],
    [
      "it succeeded and completed",
      { resultState: "succeeded" as const, state: "completed" as const },
      true,
    ],
    [
      "it failed and kept why",
      {
        result: "enc:1:a:b",
        resultState: "failed" as const,
        state: "failed" as const,
      },
      true,
    ],
    [
      "it failed but kept no reason",
      { resultState: "failed" as const, state: "failed" as const },
      false,
    ],
    [
      "it says nothing but kept a result anyway",
      { result: "enc:1:a:b" },
      false,
    ],
  ] as const) {
    test(`${allowed ? "accepts" : "refuses"} a copied payment where ${name}`, () => {
      const answer = paymentKnowsWhereItCameFrom({
        ...copiedPayment,
        ...broken,
      });
      expect(answer === null).toBe(allowed);
    });
  }
});

describe("what the provider was asked to build", () => {
  test("refuses it kept on a payment past its start", () => {
    // The checkout does not exist yet, so the payment cannot have moved on.
    expect(
      paymentKnowsWhereItCameFrom({
        ...madeHere,
        checkoutCreate: "enc:1:a:b",
        sessionReferenceIndex: null,
        sessionResource: null,
        state: "failed",
      }),
    ).not.toBe(null);
  });

  test("accepts it on a payment still being created", () => {
    expect(
      paymentKnowsWhereItCameFrom({
        ...madeHere,
        checkoutCreate: "enc:1:a:b",
        sessionReferenceIndex: null,
        sessionResource: null,
        state: "created",
      }),
    ).toBe(null);
  });
});

describe("when a buyer's details may be cleared", () => {
  const finished: StoredPayment = {
    ...madeHere,
    completion: "enc:1:a:b",
    completionState: "completed",
    state: "completed",
  };

  test("allows it once the payment is over and nobody holds it", () => {
    expect(readyToClearBuyerDetails(finished)).toBe(null);
  });

  for (const [name, broken] of [
    ["someone still holds it", { leaseToken: "w1" }],
    ["it is booked to be looked at again", { nextReconcileAt: 9 }],
    [
      "a ticket still needs the details",
      { ticketState: "ready" as const, ticketTokens: "enc:1:a:b" },
    ],
    ["it is not over yet", { state: "pending" as const }],
    [
      "it completed but the work after it did not",
      { completionState: "pending" as const },
    ],
  ] as const) {
    test(`refuses while ${name}`, () => {
      expect(readyToClearBuyerDetails({ ...finished, ...broken })).not.toBe(
        null,
      );
    });
  }
});

describe("clearing the details of a payment copied across", () => {
  const copiedAndOver: StoredPayment = { ...copiedPayment, state: "completed" };

  test("allows it once the copied payment is over", () => {
    expect(readyToClearBuyerDetails(copiedAndOver)).toBe(null);
  });

  test("refuses it while the copied payment is still going", () => {
    expect(
      readyToClearBuyerDetails({ ...copiedAndOver, state: "pending" }),
    ).not.toBe(null);
  });
});
