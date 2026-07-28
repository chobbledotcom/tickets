import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  caseStateAgreesWithItsWork,
  chargeKnowsWhereItCameFrom,
  decisionStateAgreesWithItsTries,
  mayClaimTheAlert,
  paymentKnowsWhereItCameFrom,
  readyToClearBuyerDetails,
  type StoredCase,
  type StoredCharge,
  type StoredDecision,
  type StoredPayment,
} from "#shared/payment-state/record.ts";

/** Money taken here, with nothing wrong with it. */
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

/** Money copied across on upgrade, with nothing wrong with it. */
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

describe("what a stored problem may be", () => {
  const retrying: StoredCase = {
    alertedAt: null,
    alertedRevision: null,
    alertLeaseToken: null,
    alertSentRevision: null,
    nextReconcileAt: 9,
    resolvedAt: null,
    revision: 1,
    state: "retrying",
  };
  const needsOwner: StoredCase = {
    ...retrying,
    alertedAt: 5,
    alertedRevision: 1,
    nextReconcileAt: null,
    state: "needs_action",
  };
  const settled: StoredCase = {
    ...retrying,
    nextReconcileAt: null,
    resolvedAt: 9,
    state: "resolved",
  };

  test("accepts each state held the way that state allows", () => {
    for (const problem of [retrying, needsOwner, settled]) {
      expect(caseStateAgreesWithItsWork(problem)).toBe(null);
    }
  });

  for (const [name, broken] of [
    ["a retrying problem with nothing booked", { nextReconcileAt: null }],
    [
      "a retrying problem already raised with the owner",
      { alertedAt: 5, alertedRevision: 1 },
    ],
    ["a retrying problem already settled", { resolvedAt: 9 }],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(caseStateAgreesWithItsWork({ ...retrying, ...broken })).not.toBe(
        null,
      );
    });
  }

  test("refuses a problem waiting on the owner that was never raised", () => {
    expect(
      caseStateAgreesWithItsWork({
        ...needsOwner,
        alertedAt: null,
        alertedRevision: null,
      }),
    ).not.toBe(null);
  });

  test("refuses a settled problem that says nothing about when", () => {
    expect(
      caseStateAgreesWithItsWork({ ...settled, resolvedAt: null }),
    ).not.toBe(null);
  });

  // The rule this replaces refused a claim whenever any alert had ever been
  // sent, which left a problem that gained new evidence unable to tell the
  // owner about it.
  test("allows a claim to tell the owner about a newer version", () => {
    expect(
      mayClaimTheAlert({
        ...needsOwner,
        alertedRevision: 2,
        alertSentRevision: 1,
        revision: 2,
      }),
    ).toBe(null);
  });

  test("refuses a claim once the owner has heard about this version", () => {
    expect(
      mayClaimTheAlert({ ...needsOwner, alertSentRevision: 1, revision: 1 }),
    ).not.toBe(null);
  });

  test("refuses a claim on a problem the owner is not waiting on", () => {
    expect(mayClaimTheAlert(retrying)).not.toBe(null);
  });
});

describe("what a stored decision may be", () => {
  const accepted: StoredDecision = {
    attemptCount: 0,
    decision: null,
    lastAttemptAt: null,
    lastError: null,
    nextRetryAt: null,
    state: "accepted",
  };
  const waiting: StoredDecision = {
    attemptCount: 1,
    decision: null,
    lastAttemptAt: 5,
    lastError: "enc:1:a:b",
    nextRetryAt: 9,
    state: "retrying",
  };
  const done: StoredDecision = {
    attemptCount: 1,
    decision: "enc:1:a:b",
    lastAttemptAt: 5,
    lastError: null,
    nextRetryAt: null,
    state: "completed",
  };

  test("accepts a decision taken, one waiting to try again, and one done", () => {
    for (const decision of [accepted, waiting, done]) {
      expect(decisionStateAgreesWithItsTries(decision)).toBe(null);
    }
  });

  for (const [name, decision] of [
    [
      "waiting to try again with nothing booked",
      { ...waiting, nextRetryAt: null },
    ],
    [
      "waiting to try again having never tried",
      { ...waiting, attemptCount: 0, lastAttemptAt: null },
    ],
    [
      "waiting to try again with no reason kept",
      { ...waiting, lastError: null },
    ],
    [
      "finished having never tried",
      { ...done, attemptCount: 0, lastAttemptAt: null },
    ],
    ["finished with nothing to say it did", { ...done, decision: null }],
    ["tried but with no time for the try", { ...accepted, attemptCount: 1 }],
  ] as const) {
    test(`refuses a decision ${name}`, () => {
      expect(decisionStateAgreesWithItsTries(decision)).not.toBe(null);
    });
  }
});
