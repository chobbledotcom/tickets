/** What a stored decision may be — the rules about how it behaves, as plain
 *  functions over plain data. The tables keep only what is true of a value
 *  whatever the code does; these change as the runtime is written. */

/* jscpd:ignore-start -- imports */
import type { PaymentDecisionState } from "#shared/payment-state/lifecycle.ts";
import type { Fault } from "#shared/payment-state/record/fault.ts";
import {
  absent,
  firstFault,
  present,
} from "#shared/payment-state/record/fault.ts";
/* jscpd:ignore-end */

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
    // The rule above already ties the count and the time together, and an
    // earlier fault is reported before these, so both only need the count.
    [
      !["retrying", "completed"].includes(decision.state) ||
        decision.attemptCount >= 1,
      "A decision that is retrying or finished has been tried at least once",
    ],
    [
      decision.state !== "accepted" || decision.attemptCount === 0,
      // The owner's choice can be a refund, which cannot be taken back. A
      // decision waiting to run must never be one that has already run.
      "A decision still waiting to run has not been tried",
    ],
    [
      (decision.state === "completed") === present(decision.decision),
      // Both ways round: a finished decision says what was done, and one that
      // has not finished cannot already say it — a row claiming the owner's
      // action is still queued while recording its outcome says two things at
      // once, and a worker could act on either.
      "A decision says what was done exactly when it has finished",
    ],
  ]);
