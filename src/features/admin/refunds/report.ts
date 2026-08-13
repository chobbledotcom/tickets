import { ErrorCode, logError } from "#shared/logger.ts";

export type RefundNotStartedReason =
  | "claim_changed"
  | "owner_review"
  | "payment_set_changed"
  | "provider_evidence"
  | "shared_reference"
  | "unrecorded_money";

type RefundProblem =
  | {
    attendeeId: number;
    kind: "batch_outcome";
    outcome: "failed";
    paymentCount: number;
  }
  | { error: unknown; kind: "claim_settlement" }
  | { attendeeId: number; kind: "incomplete_batch"; paymentCount: number }
  | {
    action: "refresh" | "refund";
    attendeeId: number;
    kind: "not_started";
    reason: RefundNotStartedReason;
  };

const PROBLEM_DETAIL = {
  batch_outcome: "Admin bulk refund",
  claim_settlement: "Refund claim could not be settled",
  incomplete_batch: "Admin refund did not complete all",
  not_started: "Admin",
} as const satisfies Record<RefundProblem["kind"], string>;

const problemDetail = (problem: RefundProblem): string =>
  `${PROBLEM_DETAIL[problem.kind]}${
    problem.kind === "batch_outcome"
      ? ` ${problem.outcome} for ${problem.paymentCount} payment(s)`
      : problem.kind === "incomplete_batch"
      ? ` ${problem.paymentCount} payments`
      : problem.kind === "not_started"
      ? ` ${problem.action} not started (${problem.reason})`
      : ""
  }`;

/** Report refund work using only declared, privacy-safe facts. */
export const reportRefundProblem = (
  problem: RefundProblem,
  listingId: number,
): void => {
  logError({
    ...(problem.kind === "claim_settlement"
      ? {}
      : { attendeeId: problem.attendeeId }),
    code: ErrorCode.PAYMENT_REFUND,
    detail: problemDetail(problem),
    ...("error" in problem ? { error: problem.error } : {}),
    listingId,
  });
};
