import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import { getSubrequestRemaining } from "#shared/subrequest-budget.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import {
  REFRESH_BUDGET_MESSAGE,
  REFUND_BUDGET_MESSAGES,
  type RefundBudgetAudience,
  type RefundReadinessAction,
  type RefundReadinessBudgetCheckpoint,
  refundReadinessSubrequestCost,
  subrequestCostFits,
} from "./budget.ts";
import type { RefundCandidate } from "./candidates.ts";
import { loadedRefundAttendee } from "./candidates.ts";
import {
  type HeldRefundWork,
  type RowClaim,
  underAttendeeClaim,
} from "./claim.ts";
import type {
  ReadyRefundCandidate,
  RefundReadinessResult,
} from "./readiness.ts";
import { rememberReadinessFailureFindings } from "./readiness-findings.ts";
import { refundReadinessMessage } from "./readiness-problem.ts";
import { type RefundNotStartedReason, reportRefundProblem } from "./report.ts";

type FailedReadiness = Extract<RefundReadinessResult, { kind: "not_ready" }>;
type BlockedRefundRun = { kind: "blocked"; reason: "refund_in_progress" };

const SHARED_REFERENCE_MESSAGE =
  "This payment reference is attached to more than one payment row. An owner must review it before any automatic refund can continue.";

type RefundReadinessRunBase<TResult> = {
  candidates: readonly RefundCandidate[];
  changedMessage: string;
  claim: RowClaim;
  listingId: number;
  notReady: (message: string, reason?: "subrequest_budget") => TResult;
  prepare: (
    candidates: readonly RefundCandidate[],
    claim: HeldRefundWork["claim"],
    alreadyReturned: ReadonlySet<string>,
  ) => Promise<RefundReadinessResult>;
  request?: typeof requestProviderRefund;
  ready: (
    candidates: ReadyRefundCandidate[],
    held: HeldRefundWork,
  ) => Promise<TResult>;
};

type RefundReadinessRun<TResult> =
  & RefundReadinessRunBase<TResult>
  & (
    | {
      action: Extract<RefundReadinessAction, "refund">;
      budgetAudience: RefundBudgetAudience;
    }
    | {
      action: Extract<RefundReadinessAction, "refresh">;
      budgetAudience?: never;
    }
  );

const REVIEW_REQUIRED_MESSAGE =
  "This payment still needs owner review. Refresh or correct the payment evidence before another refund.";
const MONEY_RECORD_REQUIRED_MESSAGE =
  "This returned payment is not recorded in Money yet. Refresh the payment status before another refund.";

const reportCandidateProblems = (
  run: RefundReadinessRun<unknown>,
  candidates: readonly RefundCandidate[],
  reason: RefundNotStartedReason,
): void => {
  for (const candidate of candidates) {
    reportRefundProblem(
      {
        action: run.action,
        attendeeId: candidate.attendee.id,
        kind: "not_started",
        reason,
      },
      run.listingId,
    );
  }
};

const sharedRowSessionIds = (held: HeldRefundWork): Set<string> =>
  new Set(
    [...held.shared.values()].flatMap((representations) =>
      representations.map(({ sessionId }) => sessionId)
    ),
  );

/** Record why a claimed run could not establish complete provider evidence. */
const reportReadinessFailure = async (
  run: RefundReadinessRun<unknown>,
  candidates: readonly RefundCandidate[],
  readiness: FailedReadiness,
  held: HeldRefundWork,
): Promise<string> => {
  const message = refundReadinessMessage(readiness);
  await rememberReadinessFailureFindings(
    candidates,
    readiness,
    held,
    run.request ?? requestProviderRefund,
  );
  reportCandidateProblems(run, candidates, readiness.reason);
  return message;
};

/** Park every exact representation before provider preparation can run. */
const reportSharedReference = (
  run: RefundReadinessRun<unknown>,
  held: HeldRefundWork,
): string => {
  for (const sessionId of sharedRowSessionIds(held)) {
    held.findings.reviews.set(sessionId, {
      kind: "review",
      reason: { kind: "shared_reference" },
    });
  }
  reportCandidateProblems(run, run.candidates, "shared_reference");
  return SHARED_REFERENCE_MESSAGE;
};

/** Make the exact indexed row set authoritative for shared-reference work. */
const reconcileSharedReferences = (held: HeldRefundWork): void => {
  const shared = sharedRowSessionIds(held);
  for (const [sessionId, reason] of held.reviews) {
    if (
      PAYMENT_REVIEW_RETIREMENT[reason.kind] === "unique_reference" &&
      !shared.has(sessionId)
    ) {
      held.findings.reviews.set(sessionId, {
        kind: "resolved",
        reason: "shared_reference",
      });
    }
  }
};

const hasUnresolvedReview = (held: HeldRefundWork): boolean =>
  [...held.reviews].some(
    ([sessionId]) => held.findings.reviews.get(sessionId)?.kind !== "resolved",
  );

/** A send refuses facts that only refresh is allowed to reconcile. */
type RefundAdmissionProblem = {
  message: string;
  reason: Extract<RefundNotStartedReason, "owner_review" | "unrecorded_money">;
};

const refundAdmissionProblem = (
  held: HeldRefundWork,
): RefundAdmissionProblem | null => {
  if (hasUnresolvedReview(held)) {
    return { message: REVIEW_REQUIRED_MESSAGE, reason: "owner_review" };
  }
  return held.unrecorded.size > 0
    ? { message: MONEY_RECORD_REQUIRED_MESSAGE, reason: "unrecorded_money" }
    : null;
};

/** Every operation declares whether unresolved safety work may enter it. */
const ADMISSION_BY_ACTION = {
  refresh: (_held: HeldRefundWork) => null,
  refund: refundAdmissionProblem,
} satisfies Record<
  RefundReadinessAction,
  (held: HeldRefundWork) => RefundAdmissionProblem | null
>;

const budgetFits = (
  action: RefundReadinessAction,
  candidates: readonly LoadedRefundAttendee[],
  returned: ReadonlySet<string>,
  checkpoint: RefundReadinessBudgetCheckpoint,
): boolean => {
  const cost = refundReadinessSubrequestCost(
    action,
    candidates,
    returned,
    checkpoint,
  );
  const remaining = getSubrequestRemaining();
  const fits = subrequestCostFits(cost, remaining);
  if (!fits) {
    throw new Error(
      `DEBUG refund budget ${checkpoint}: cost=${JSON.stringify(cost)} remaining=${JSON.stringify(remaining)}`,
    );
  }
  return fits;
};

const loadedBudgetCandidates = (
  candidates: readonly RefundCandidate[],
): LoadedRefundAttendee[] => candidates.map(loadedRefundAttendee);

const refuseForBudget = <TResult>(
  run: RefundReadinessRun<TResult>,
): TResult => {
  const message = run.action === "refresh"
    ? REFRESH_BUDGET_MESSAGE
    : REFUND_BUDGET_MESSAGES[run.budgetAudience];
  return run.notReady(message, "subrequest_budget");
};

/** Claim the exact loaded rows, establish provider readiness, then run them. */
export const runRefundReadiness = async <TResult>(
  run: RefundReadinessRun<TResult>,
): Promise<TResult | BlockedRefundRun> => {
  if (
    !budgetFits(
      run.action,
      loadedBudgetCandidates(run.candidates),
      new Set(),
      "before_claim",
    )
  ) {
    return refuseForBudget(run);
  }
  return await underAttendeeClaim(
    run.claim,
    loadedBudgetCandidates(run.candidates),
    run.listingId,
    {
      admissionRefused: () => refuseForBudget(run),
      admit: ({ attendees, returned }) =>
        budgetFits(run.action, attendees, returned, "inside_claim"),
      blocked: (block) => {
        if (block.kind === "claim_held") {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        reportCandidateProblems(run, run.candidates, block.kind);
        return run.notReady(run.changedMessage);
      },
      work: async (held) => {
        reconcileSharedReferences(held);
        if (held.shared.size > 0) {
          return run.notReady(reportSharedReference(run, held));
        }
        const admissionProblem = ADMISSION_BY_ACTION[run.action](held);
        if (admissionProblem !== null) {
          reportCandidateProblems(run, run.candidates, admissionProblem.reason);
          return run.notReady(admissionProblem.message);
        }
        if (
          !budgetFits(
            run.action,
            loadedBudgetCandidates(run.candidates),
            held.alreadyReturned,
            "before_provider_read",
          )
        ) {
          return refuseForBudget(run);
        }
        const readiness = await run.prepare(
          run.candidates,
          held.claim,
          held.alreadyReturned,
        );
        if (readiness.kind === "not_ready") {
          return run.notReady(
            await reportReadinessFailure(
              run,
              run.candidates,
              readiness,
              held,
            ),
          );
        }
        return await run.ready(readiness.candidates, held);
      },
    },
  );
};
