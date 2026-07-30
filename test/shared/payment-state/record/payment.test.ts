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
  leaseExpiresAt: null,
  leaseToken: null,
  legacyRuntime: null,
  mode: "test",
  nextReconcileAt: null,
  origin: "current",
  provider: "stripe",
  result: null,
  resultState: "none",
  revision: 1,
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
  test("accepts a payment that asks for nothing", () => {
    // A free booking still opens a payment, so the floor has to let nothing
    // through — only less than nothing is wrong.
    expect(
      paymentKnowsWhereItCameFrom({ ...madeHere, expectedAmount: 0 }),
    ).toBe(null);
  });

  test("accepts a payment made here and one copied across", () => {
    expect(paymentKnowsWhereItCameFrom(madeHere)).toBe(null);
    expect(paymentKnowsWhereItCameFrom(copiedPayment)).toBe(null);
  });

  // Each case names the one thing that is wrong, so a rule cannot quietly stop
  // saying it — and a failure here points at the rule that broke.
  const KNOWS_ITS_MONEY =
    "A payment made here knows who takes the money, how much, and what for";

  for (const [name, broken, fault] of [
    [
      "it knows nothing about the money",
      { expectedAmount: null },
      KNOWS_ITS_MONEY,
    ],
    ["it names no account", { accountId: null }, KNOWS_ITS_MONEY],
    [
      "it asks for less than nothing",
      { expectedAmount: -1 },
      "The money a payment asks for cannot be less than nothing",
    ],
    [
      "it carries an old payment's record",
      { legacyRuntime: "enc:1:a:b" },
      "A payment made here has no old record to carry",
    ],
    [
      "it is past its start with no checkout",
      { sessionReferenceIndex: null, sessionResource: null },
      "A payment past its start must know the checkout it belongs to",
    ],
    [
      "it keeps a checkout nothing can find again",
      { sessionReferenceIndex: null },
      "A checkout is kept with the code that finds it again",
    ],
    [
      "it is claimed by a worker with no end to the claim",
      { leaseToken: "w1" },
      "A worker's claim on a payment says when it runs out",
    ],
    [
      "its version counts from nothing",
      { revision: 0 },
      "A payment's version counts up from one",
    ],
    [
      "it still holds what the provider was asked to build",
      { checkoutCreate: "enc:1:a:b" },
      "What the provider was asked to build is kept only until it exists",
    ],
    [
      "it says it has a result but keeps none",
      { resultState: "succeeded" as const },
      "A payment has its result exactly when it says it has one",
    ],
    [
      "its tickets are ready but it has none",
      { ticketState: "ready" as const },
      "A payment has its tickets exactly when it says they are ready",
    ],
    [
      "work is still to do with nothing booked",
      { completion: "enc:1:a:b", completionState: "pending" as const },
      "Work still to do must be booked in to be looked at again",
    ],
    [
      "it has work nobody knows about",
      { completion: "enc:1:a:b", completionState: "legacy_unknown" as const },
      "Only a payment copied across can have work nobody knows about",
    ],
    [
      "it keeps after-work while saying there is none",
      { completion: "enc:1:a:b" },
      "A payment has its after-work exactly when it says there is some",
    ],
  ] as const) {
    test(`refuses a payment made here when ${name}`, () => {
      expect(paymentKnowsWhereItCameFrom({ ...madeHere, ...broken })).toBe(
        fault,
      );
    });
  }

  for (const [name, broken, fault] of [
    [
      "it keeps no old record",
      { legacyRuntime: null },
      "A payment copied across must keep the old record it came from",
    ],
    [
      "it knows what was being bought",
      { bookingIntent: "enc:1:a:b" },
      "A payment copied across never knew who took the money, or what for",
    ],
    [
      "it invents a provider for itself",
      { provider: "stripe" },
      "A payment copied across never knew who took the money, or what for",
    ],
    [
      "it succeeded without completing",
      { resultState: "succeeded" as const, state: "failed" as const },
      "How a copied payment turned out must agree with where it got to",
    ],
    [
      "work nobody knows about on an unfinished payment",
      { completionState: "legacy_unknown" as const, state: "failed" as const },
      "Only a completed copied payment can have work nobody knows about",
    ],
    [
      "it recorded the work done after it",
      { completion: "enc:1:a:b" },
      "A payment copied across never recorded the work done after it",
    ],
  ] as const) {
    test(`refuses a payment copied across when ${name}`, () => {
      expect(paymentKnowsWhereItCameFrom({ ...copiedPayment, ...broken })).toBe(
        fault,
      );
    });
  }
});

describe("how a copied payment turned out", () => {
  for (const [name, broken, fault] of [
    ["it says nothing and kept nothing", {}, null],
    [
      "it succeeded and completed",
      { resultState: "succeeded" as const, state: "completed" as const },
      null,
    ],
    [
      "it failed and kept why",
      {
        result: "enc:1:a:b",
        resultState: "failed" as const,
        state: "failed" as const,
      },
      null,
    ],
    [
      "it failed but kept no reason",
      { resultState: "failed" as const, state: "failed" as const },
      "How a copied payment turned out must agree with where it got to",
    ],
    [
      "it succeeded but kept a reason anyway",
      {
        result: "enc:1:a:b",
        resultState: "succeeded" as const,
        state: "completed" as const,
      },
      "How a copied payment turned out must agree with where it got to",
    ],
    [
      "it says nothing but kept a result anyway",
      { result: "enc:1:a:b" },
      "How a copied payment turned out must agree with where it got to",
    ],
  ] as const) {
    test(`${fault === null ? "accepts" : "refuses"} a copied payment where ${name}`, () => {
      const answer = paymentKnowsWhereItCameFrom({
        ...copiedPayment,
        ...broken,
      });
      expect(answer).toBe(fault);
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
    ).toBe("What the provider was asked to build is kept only until it exists");
  });

  test("accepts a payment that failed before its checkout existed", () => {
    // A checkout that never came into being leaves nothing to point at, and
    // the payment is over, so there is nothing left to wait for either.
    expect(
      paymentKnowsWhereItCameFrom({
        ...madeHere,
        sessionReferenceIndex: null,
        sessionResource: null,
        state: "failed",
      }),
    ).toBe(null);
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

  // Every way a payment made here can be over: it failed, or it completed or
  // was fully refunded with the work after it done.
  for (const [name, over] of [
    [
      "it failed",
      { completionState: "none" as const, state: "failed" as const },
    ],
    ["everything was given back", { state: "fully_refunded" as const }],
  ] as const) {
    test(`allows it once ${name}`, () => {
      expect(
        readyToClearBuyerDetails({
          ...finished,
          ...over,
          ...(over.completionState === "none" ? { completion: null } : {}),
        }),
      ).toBe(null);
    });
  }

  for (const [name, broken, fault] of [
    [
      "someone still holds it",
      { leaseToken: "w1" },
      "Someone still holds this payment",
    ],
    [
      "it is booked to be looked at again",
      { nextReconcileAt: 9 },
      "This payment is still booked in to be looked at",
    ],
    [
      "a ticket still needs the details",
      { ticketState: "ready" as const, ticketTokens: "enc:1:a:b" },
      "A ticket still needs these details",
    ],
    [
      "it is not over yet",
      { state: "pending" as const },
      "This payment is not over yet",
    ],
    [
      "it completed but the work after it did not",
      { completionState: "pending" as const },
      "This payment is not over yet",
    ],
  ] as const) {
    test(`refuses while ${name}`, () => {
      expect(readyToClearBuyerDetails({ ...finished, ...broken })).toBe(fault);
    });
  }
});

describe("clearing the details of a payment copied across", () => {
  const copiedAndOver: StoredPayment = { ...copiedPayment, state: "completed" };

  // Every way a copied payment can be over. It records no after-work, so
  // unlike one made here it needs nothing beyond where it got to.
  for (const state of ["completed", "failed", "fully_refunded"] as const) {
    test(`allows it once the copied payment says ${state}`, () => {
      expect(readyToClearBuyerDetails({ ...copiedAndOver, state })).toBe(null);
    });
  }

  test("refuses it while the copied payment is still going", () => {
    expect(
      readyToClearBuyerDetails({ ...copiedAndOver, state: "pending" }),
    ).toBe("This payment is not over yet");
  });
});
