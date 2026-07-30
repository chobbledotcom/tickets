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
    alertSentAt: null,
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

  // Each case names the one thing that is wrong, so a rule cannot quietly stop
  // saying it — and a failure here points at the rule that broke.
  for (const [name, broken, fault] of [
    [
      "a retrying problem with nothing booked",
      { nextReconcileAt: null },
      "A problem being retried is booked to be looked at",
    ],
    [
      "a retrying problem already raised with the owner",
      { alertedAt: 5, alertedRevision: 1 },
      "A problem being retried has not been raised with the owner",
    ],
    [
      "a retrying problem already settled",
      { resolvedAt: 9 },
      "A problem being retried is not settled",
    ],
    // Nobody is telling the owner about a problem that is going back for
    // another look, so a claim left behind would hold an alert forever.
    [
      "a retrying problem somebody still holds the alert on",
      { alertLeaseToken: "worker-1" },
      "A problem being retried has nobody part-way through telling the owner",
    ],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(caseStateAgreesWithItsWork({ ...retrying, ...broken })).toBe(
        fault,
      );
    });
  }

  test("refuses a settled problem somebody still holds the alert on", () => {
    // The problem is over, so a claim still standing would leave a worker
    // about to tell the owner about something that no longer needs them.
    expect(
      caseStateAgreesWithItsWork({ ...settled, alertLeaseToken: "worker-1" }),
    ).toBe("A settled problem has nobody part-way through telling the owner");
  });

  test("refuses a problem waiting on the owner that was never raised", () => {
    expect(
      caseStateAgreesWithItsWork({
        ...needsOwner,
        alertedAt: null,
        alertedRevision: null,
      }),
    ).toBe("A problem waiting on the owner has been raised with them");
  });

  test("refuses a problem waiting on the owner still booked to be looked at", () => {
    expect(
      caseStateAgreesWithItsWork({ ...needsOwner, nextReconcileAt: 9 }),
    ).toBe("A problem waiting on the owner is not booked to be looked at");
  });

  test("refuses a problem waiting on the owner that is already settled", () => {
    expect(caseStateAgreesWithItsWork({ ...needsOwner, resolvedAt: 9 })).toBe(
      "A problem waiting on the owner is not settled",
    );
  });

  test("refuses a settled problem still booked to be looked at", () => {
    expect(caseStateAgreesWithItsWork({ ...settled, nextReconcileAt: 9 })).toBe(
      "A settled problem is not booked to be looked at",
    );
  });

  test("refuses a settled problem that says nothing about when", () => {
    expect(caseStateAgreesWithItsWork({ ...settled, resolvedAt: null })).toBe(
      "A settled problem says when it was settled",
    );
  });

  // The rule this replaces refused a claim whenever any alert had ever been
  // sent, which left a problem that gained new evidence unable to tell the
  // owner about it.
  test("allows a claim to tell the owner about a newer version", () => {
    expect(
      mayClaimTheAlert({
        ...needsOwner,
        alertedRevision: 2,
        alertSentAt: 5,
        alertSentRevision: 1,
        revision: 2,
      }),
    ).toBe(null);
  });

  test("refuses a claim once the owner has heard about this version", () => {
    expect(
      mayClaimTheAlert({
        ...needsOwner,
        alertSentAt: 5,
        alertSentRevision: 1,
        revision: 1,
      }),
    ).toBe("The owner has already been told about this version");
  });

  test("refuses a claim when an alert was only half written down", () => {
    // The version alone is what stops a second send, so a version with no
    // time behind it would silence an alert that never went.
    expect(mayClaimTheAlert({ ...needsOwner, alertSentRevision: 2 })).toBe(
      "An alert says both when it went and which version it was for",
    );
  });

  test("refuses a claim on a problem the owner is not waiting on", () => {
    expect(mayClaimTheAlert(retrying)).toBe(
      "Only a problem waiting on the owner has an alert to send",
    );
  });
});
