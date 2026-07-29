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
    [
      !["retrying", "completed"].includes(decision.state) ||
        (decision.attemptCount >= 1 && present(decision.lastAttemptAt)),
      "A decision that is retrying or finished has been tried at least once",
    ],
    [
      decision.state !== "accepted" ||
        (decision.attemptCount === 0 && absent(decision.lastAttemptAt)),
      // The owner's choice can be a refund, which cannot be taken back. A
      // decision waiting to run must never be one that has already run.
      "A decision still waiting to run has not been tried",
    ],
    [
      present(decision.decision) ||
        ["accepted", "running", "retrying"].includes(decision.state),
      "A finished decision says what was actually done",
    ],
  ]);
