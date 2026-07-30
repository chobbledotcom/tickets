/** What a stored problem for the owner may be — the rules about how it behaves, as plain
 *  functions over plain data. The tables keep only what is true of a value
 *  whatever the code does; these change as the runtime is written. */

/* jscpd:ignore-start -- imports */
import type { PaymentCaseState } from "#shared/payment-state/lifecycle.ts";
import type { Fault } from "#shared/payment-state/record/fault.ts";
import {
  absent,
  allSaySomething,
  firstFault,
  present,
} from "#shared/payment-state/record/fault.ts";
/* jscpd:ignore-end */

/** A stored problem for the owner, in the shape the tables hold it. */
export type StoredCase = {
  state: PaymentCaseState;
  nextReconcileAt: number | null;
  resolvedAt: number | null;
  alertedAt: number | null;
  alertedRevision: number | null;
  alertSentAt: number | null;
  alertSentRevision: number | null;
  alertLeaseToken: string | null;
  consecutiveCount: number;
  alertLeaseExpiresAt: number | null;
  revision: number;
};

/** What each state of a problem allows. */
export const caseStateAgreesWithItsWork = (problem: StoredCase): Fault => {
  const byState: Record<PaymentCaseState, [boolean, string][]> = {
    needs_action: [
      [
        absent(problem.nextReconcileAt),
        "A problem waiting on the owner is not booked to be looked at",
      ],
      [
        absent(problem.resolvedAt),
        "A problem waiting on the owner is not settled",
      ],
      [
        present(problem.alertedAt),
        "A problem waiting on the owner has been raised with them",
      ],
    ],
    resolved: [
      [
        absent(problem.nextReconcileAt),
        "A settled problem is not booked to be looked at",
      ],
      [
        present(problem.resolvedAt),
        "A settled problem says when it was settled",
      ],
      [
        absent(problem.alertLeaseToken),
        "A settled problem has nobody part-way through telling the owner",
      ],
    ],
    retrying: [
      [
        present(problem.nextReconcileAt),
        "A problem being retried is booked to be looked at",
      ],
      [absent(problem.resolvedAt), "A problem being retried is not settled"],
      [
        absent(problem.alertedAt),
        "A problem being retried has not been raised with the owner",
      ],
      [
        absent(problem.alertLeaseToken),
        "A problem being retried has nobody part-way through telling the owner",
      ],
    ],
  };
  return firstFault([
    [
      // The owner's claim on a problem carries this version, and a claim is
      // only valid from one. A version below it could never produce a claim,
      // so the owner could never be asked to decide.
      problem.revision >= 1,
      "A problem's version counts up from one",
    ],
    [
      // This counter is what decides when repeated failures become the
      // owner's problem, so one below nothing quietly puts that off.
      problem.consecutiveCount >= 0,
      "A problem cannot have failed fewer than nothing times in a row",
    ],
    ...byState[problem.state],
  ]);
};

/**
 * A claim on telling the owner may only be held while they still need telling
 * about the version in front of them — which is not the same as never having
 * been told. A problem that gains new evidence moves to a new version, and the
 * owner has to hear about that one too.
 */
export const mayClaimTheAlert = (problem: StoredCase): Fault =>
  firstFault([
    [
      problem.state === "needs_action",
      "Only a problem waiting on the owner has an alert to send",
    ],
    [
      // The version alone is what stops the same alert going twice, so a
      // version written without the time it went reads as "already told" for
      // a send that never happened, and the owner never hears about it.
      present(problem.alertSentAt) === present(problem.alertSentRevision),
      "An alert says both when it went and which version it was for",
    ],
    [
      // A claim with no end never goes stale, so a worker that dies part-way
      // through telling the owner would hold the alert for good.
      present(problem.alertLeaseToken) === present(problem.alertLeaseExpiresAt),
      "A claim on telling the owner says when it runs out",
    ],
    [
      allSaySomething([problem.alertLeaseToken]),
      "A claim on telling the owner must say something",
    ],
    [
      problem.alertSentRevision !== problem.revision,
      "The owner has already been told about this version",
    ],
  ]);
