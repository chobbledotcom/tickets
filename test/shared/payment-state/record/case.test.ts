import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  caseStateAgreesWithItsWork,
  mayClaimTheAlert,
  type StoredCase,
} from "#shared/payment-state/record/case.ts";

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
