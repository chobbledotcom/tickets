/**
 * What a stored payment record may be.
 *
 * These are the rules about how a payment *behaves* — which fields go together
 * for the state a thing is in. They used to be written into the tables as SQL,
 * where they were hard to read, needed a database to test, and could only be
 * changed by rebuilding the table. They live here instead, as plain functions
 * over plain data, so the record layer can check a row on its way in and say
 * exactly what was wrong with it.
 *
 * The tables still refuse anything that is the wrong shape whatever the code
 * does: wrong type, missing, not one of the allowed words, not properly hidden,
 * a time before the moment it is measured from, money given back beyond money
 * taken. Those never change. These do, as the runtime is written.
 *
 * Every function here is pure: data in, an answer out, no database.
 */

import type {
  PaymentCaseState,
  PaymentDecisionState,
  PaymentRefundState,
  PaymentSessionState,
} from "#shared/payment-state/lifecycle.ts";
import { LEGACY_SOURCES } from "#shared/payment-state/words.ts";

/** Reads as "nothing was wrong" or the one thing that was. */
export type Fault = string | null;

const firstFault = (checks: [boolean, string][]): Fault =>
  checks.find(([holds]) => !holds)?.[1] ?? null;

/** The first of several answers that found something wrong. */
const firstOf = (...faults: Fault[]): Fault =>
  faults.find((fault) => fault !== null) ?? null;

const present = (value: unknown): boolean =>
  value !== null && value !== undefined;
const absent = (value: unknown): boolean => !present(value);
const allAbsent = (values: unknown[]): boolean => values.every(absent);

/** A stored charge, in the shape the tables hold it. */
export type StoredCharge = {
  origin: "current" | "legacy";
  provider: string | null;
  resourceKind: string | null;
  referenceIndex: string | null;
  capturedAmount: number | null;
  currency: string | null;
  refundedAmount: number | null;
  refundState: PaymentRefundState;
  pendingRefundId: string | null;
  pendingRefundIndex: string | null;
  pendingRefundIdempotencyKey: string | null;
  pendingRefundKeyIndex: string | null;
  providerRefundedAt: number | null;
  legacySource: string | null;
};

/**
 * Which refund handles a charge may hold, for where its refund has got to.
 *
 * A refund still going is the open one: it may have been started in the
 * provider's own dashboard, so we may hold neither handle for it.
 */
export const refundHandlesMatchState = (charge: StoredCharge): Fault => {
  const { pendingRefundId: id, pendingRefundIdempotencyKey: key } = charge;
  if (charge.refundState === "requested") {
    return present(id)
      ? "A refund only asked for cannot already name the provider's refund"
      : absent(key)
        ? "A refund asked for must keep the key that stops it being asked twice"
        : null;
  }
  if (charge.refundState === "pending") return null;
  if (charge.refundState === "failed") {
    return present(id)
      ? "A refund that failed cannot still name a refund in progress"
      : null;
  }
  return allAbsent([id, key])
    ? null
    : "A charge with no refund in progress cannot hold a refund's handles";
};

/** How much a charge says has gone back must agree with where its refund is. */
export const refundedTotalMatchesState = (charge: StoredCharge): Fault => {
  const { capturedAmount: taken, refundedAmount: back } = charge;
  if (taken === null || back === null) return null;
  return firstFault([
    [
      !["requested", "pending"].includes(charge.refundState) || back < taken,
      "A refund still being asked for cannot already claim everything taken",
    ],
    [
      charge.refundState !== "none" || back === 0,
      "A charge with no refund cannot have money already gone back",
    ],
    [
      charge.refundState !== "partial" || (back > 0 && back < taken),
      "A part refund must have given back some of the money, but not all",
    ],
    [
      charge.refundState !== "completed" || back === taken,
      "A finished refund must have given back everything taken",
    ],
  ]);
};

/** The six things a charge knows when the money was taken here — and knows
 *  none of when it was copied across. */
const whatMoneyTakenHereKnows = (charge: StoredCharge): unknown[] => [
  charge.provider,
  charge.resourceKind,
  charge.referenceIndex,
  charge.capturedAmount,
  charge.currency,
  charge.refundedAmount,
];

/** The handles a charge holds while a refund is in progress. */
const refundHandles = (charge: StoredCharge): unknown[] => [
  charge.pendingRefundId,
  charge.pendingRefundIndex,
  charge.pendingRefundIdempotencyKey,
  charge.pendingRefundKeyIndex,
];

/** Money copied across knows only that it happened. */
const moneyCopiedAcrossIsBare = (charge: StoredCharge): Fault =>
  firstFault([
    [
      allAbsent([...whatMoneyTakenHereKnows(charge), ...refundHandles(charge)]),
      "Money copied across knows only that it happened, nothing more",
    ],
    [
      charge.refundState === "unknown",
      "Money copied across never said what became of its refund",
    ],
    [
      LEGACY_SOURCES.some((source) => source === charge.legacySource),
      "Money copied across must say which old table it came from",
    ],
  ]);

/** Money taken here knows everything about itself. */
const moneyTakenHereIsComplete = (charge: StoredCharge): Fault =>
  firstFault([
    [
      allAbsent([charge.legacySource, charge.providerRefundedAt]),
      "Money taken here cannot carry an old record's details",
    ],
    [
      whatMoneyTakenHereKnows(charge).every(present),
      "Money taken here knows who took it, how much, and how to find it again",
    ],
    [
      charge.refundState !== "unknown",
      `Only money copied across may say its refund is "unknown"`,
    ],
  ]);

/** A charge is either money taken here or money copied across, never a mix. */
export const chargeKnowsWhereItCameFrom = (charge: StoredCharge): Fault =>
  charge.origin === "current"
    ? firstOf(
        moneyTakenHereIsComplete(charge),
        refundHandlesMatchState(charge),
        refundedTotalMatchesState(charge),
      )
    : moneyCopiedAcrossIsBare(charge);

/** A stored payment, in the shape the tables hold it. */
export type StoredPayment = {
  origin: "current" | "legacy";
  provider: string | null;
  mode: string | null;
  accountId: string | null;
  expectedAmount: number | null;
  expectedCurrency: string | null;
  bookingIntent: string | null;
  checkoutCreate: string | null;
  sessionResource: string | null;
  sessionReferenceIndex: string | null;
  state: PaymentSessionState;
  nextReconcileAt: number | null;
  leaseToken: string | null;
  resultState: "none" | "succeeded" | "failed";
  result: string | null;
  ticketState: "none" | "ready" | "consumed";
  ticketTokens: string | null;
  completionState: "none" | "pending" | "completed" | "legacy_unknown";
  completion: string | null;
  legacyRuntime: string | null;
};

/** Tickets and the work after payment are held the same way either side. */
const paymentBookkeepingHolds = (
  payment: StoredPayment,
): [boolean, string][] => [
  [
    (payment.ticketState === "ready") === present(payment.ticketTokens),
    "A payment has its tickets exactly when it says they are ready",
  ],
];

/** A payment is either made here or copied across, never a mix. */
export const paymentKnowsWhereItCameFrom = (payment: StoredPayment): Fault => {
  if (payment.origin === "legacy") {
    return firstFault([
      [
        present(payment.legacyRuntime),
        "A payment copied across must keep the old record it came from",
      ],
      [
        allAbsent([
          payment.bookingIntent,
          payment.checkoutCreate,
          payment.sessionResource,
          payment.sessionReferenceIndex,
        ]),
        "A payment copied across never knew what was being bought",
      ],
      [
        (payment.resultState === "none" && absent(payment.result)) ||
          (payment.resultState === "succeeded" &&
            absent(payment.result) &&
            payment.state === "completed") ||
          (payment.resultState === "failed" &&
            present(payment.result) &&
            payment.state === "failed"),
        "How a copied payment turned out must agree with where it got to",
      ],
      ...paymentBookkeepingHolds(payment),
      [
        ["none", "legacy_unknown"].includes(payment.completionState) &&
          absent(payment.completion),
        "A payment copied across never recorded the work done after it",
      ],
      [
        payment.completionState !== "legacy_unknown" ||
          payment.state === "completed",
        "Only a completed copied payment can have work nobody knows about",
      ],
    ]);
  }
  return firstFault([
    [
      absent(payment.legacyRuntime),
      "A payment made here has no old record to carry",
    ],
    [
      [
        payment.provider,
        payment.mode,
        payment.accountId,
        payment.expectedAmount,
        payment.expectedCurrency,
        payment.bookingIntent,
      ].every(present),
      "A payment made here knows who takes the money, how much, and what for",
    ],
    [
      absent(payment.checkoutCreate) ||
        (absent(payment.sessionResource) && payment.state === "created"),
      "What the provider was asked to build is kept only until it exists",
    ],
    [
      present(payment.sessionResource) ||
        ["created", "failed"].includes(payment.state),
      "A payment past its start must know the checkout it belongs to",
    ],
    [
      (payment.resultState === "none") === absent(payment.result),
      "A payment has its result exactly when it says it has one",
    ],
    ...paymentBookkeepingHolds(payment),
    [
      (payment.completionState === "none") === absent(payment.completion),
      "A payment has its after-work exactly when it says there is some",
    ],
    [
      payment.completionState !== "pending" || present(payment.nextReconcileAt),
      "Work still to do must be booked in to be looked at again",
    ],
    [
      payment.completionState !== "legacy_unknown",
      "Only a payment copied across can have work nobody knows about",
    ],
  ]);
};

/** When a buyer's details may be cleared from a payment. */
export const readyToClearBuyerDetails = (payment: StoredPayment): Fault =>
  firstFault([
    [absent(payment.leaseToken), "Someone still holds this payment"],
    [
      absent(payment.nextReconcileAt),
      "This payment is still booked in to be looked at",
    ],
    [payment.ticketState !== "ready", "A ticket still needs these details"],
    [
      payment.origin === "legacy"
        ? ["completed", "failed", "fully_refunded"].includes(payment.state)
        : payment.state === "failed" ||
          (["completed", "fully_refunded"].includes(payment.state) &&
            payment.completionState === "completed"),
      "This payment is not over yet",
    ],
  ]);

/** A stored problem for the owner, in the shape the tables hold it. */
export type StoredCase = {
  state: PaymentCaseState;
  nextReconcileAt: number | null;
  resolvedAt: number | null;
  alertedAt: number | null;
  alertedRevision: number | null;
  alertSentRevision: number | null;
  alertLeaseToken: string | null;
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
    ],
  };
  return firstFault(byState[problem.state]);
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
      problem.alertSentRevision !== problem.revision,
      "The owner has already been told about this version",
    ],
  ]);

/** A stored decision, in the shape the tables hold it. */
export type StoredDecision = {
  state: PaymentDecisionState;
  decision: string | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  lastError: string | null;
};

/** What each state of a decision allows. */
export const decisionStateAgreesWithItsTries = (
  decision: StoredDecision,
): Fault =>
  firstFault([
    [
      (decision.state === "retrying") === present(decision.nextRetryAt),
      "A decision is booked to try again exactly when it is waiting to",
    ],
    [
      (decision.state === "retrying") === present(decision.lastError),
      "A decision keeps why it failed exactly when it is waiting to try again",
    ],
    [
      (decision.attemptCount === 0) === absent(decision.lastAttemptAt),
      "A decision has a last try exactly when it has been tried",
    ],
    [
      !["retrying", "completed"].includes(decision.state) ||
        (decision.attemptCount >= 1 && present(decision.lastAttemptAt)),
      "A decision that is retrying or finished has been tried at least once",
    ],
    [
      present(decision.decision) ||
        ["accepted", "running", "retrying"].includes(decision.state),
      "A finished decision says what was actually done",
    ],
  ]);
