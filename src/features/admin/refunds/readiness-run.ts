import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import { getSubrequestRemaining } from "#shared/subrequest-budget.ts";
import {
  REFUND_BUDGET_MESSAGES,
  type RefundBudgetAudience,
  type RefundReadinessBudgetCheckpoint,
  refundSubrequestCost,
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
import {
  rememberReadinessFailureFindings,
  rememberRefundDoubts,
} from "./readiness-findings.ts";
import { refundReadinessMessage } from "./readiness-problem.ts";
import { reportRefundProblem } from "./report.ts";

type FailedReadiness = Extract<RefundReadinessResult, { kind: "not_ready" }>;
type BlockedRefundRun = { kind: "blocked"; reason: "refund_in_progress" };

const SHARED_REFERENCE_MESSAGE =
  "This payment reference is attached to more than one payment row. An owner must review it before any automatic refund can continue.";

type RefundReadinessAction = "refund" | "refresh";

type RefundReadinessRun<TResult> = {
  action: RefundReadinessAction;
  budgetAudience?: RefundBudgetAudience;
  candidates: readonly RefundCandidate[];
  changedMessage: string;
  claim: RowClaim;
  label: string;
  listingId: number;
  notReady: (message: string, reason?: "subrequest_budget") => TResult;
  prepare: (
    candidates: readonly RefundCandidate[],
    claim: HeldRefundWork["claim"],
    alreadyReturned: ReadonlySet<string>,
  ) => Promise<RefundReadinessResult>;
  ready: (
    candidates: ReadyRefundCandidate[],
    held: HeldRefundWork,
  ) => Promise<TResult>;
};

const REVIEW_REQUIRED_MESSAGE =
  "This payment still needs owner review. Refresh or correct the payment evidence before another refund.";
const MONEY_RECORD_REQUIRED_MESSAGE =
  "This returned payment is not recorded in Money yet. Refresh the payment status before another refund.";

const reportCandidateProblems = (
  run: RefundReadinessRun<unknown>,
  candidates: readonly RefundCandidate[],
  message: string,
): void => {
  for (const candidate of candidates) {
    reportRefundProblem(
      `${run.label} not started for attendee ${candidate.attendee.id}: ${message}`,
      run.listingId,
    );
  }
};

const sharedRowSessionIds = (held: HeldRefundWork): Set<string> =>
  new Set(
    [...held.shared.values()].flatMap((representations) =>
      representations.map(({ sessionId }) => sessionId),
    ),
  );

/** Record why a claimed run could not establish complete provider evidence. */
const reportReadinessFailure = (
  run: RefundReadinessRun<unknown>,
  candidates: readonly RefundCandidate[],
  readiness: FailedReadiness,
  held: HeldRefundWork,
): string => {
  const message = refundReadinessMessage(readiness);
  rememberReadinessFailureFindings(candidates, readiness, held);
  reportCandidateProblems(run, candidates, message);
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
  reportCandidateProblems(run, run.candidates, SHARED_REFERENCE_MESSAGE);
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
const refundAdmissionProblem = (held: HeldRefundWork): string | null => {
  if (hasUnresolvedReview(held)) return REVIEW_REQUIRED_MESSAGE;
  return held.unrecorded.size > 0 ? MONEY_RECORD_REQUIRED_MESSAGE : null;
};

/** Every operation declares whether unresolved safety work may enter it. */
const ADMISSION_BY_ACTION = {
  refresh: (_held: HeldRefundWork) => null,
  refund: refundAdmissionProblem,
} satisfies Record<
  RefundReadinessAction,
  (held: HeldRefundWork) => string | null
>;

/** Readiness retires checking, never the protection around a resumed send.
 *  Each action removes that protection only after its own durable outcome. */
const rememberCheckedPhases = (
  held: HeldRefundWork,
  execution: HeldRefundWork["claim"],
): void => {
  for (const [sessionId, phase] of execution.phases) {
    if (phase === "checking") {
      held.findings.claimPhases.set(sessionId, "ready");
    }
  }
};

/** Keep the claim when provider preparation ends without a complete answer. */
const protectProviderReads = (
  candidates: readonly RefundCandidate[],
  held: HeldRefundWork,
): void => {
  const needingProtection = candidates.filter((candidate) =>
    candidate.references.some(
      (reference) =>
        reference.refundState !== "completed" &&
        !held.alreadyReturned.has(reference.index),
    ),
  );
  rememberRefundDoubts(needingProtection, held, "in_doubt");
};

const budgetFits = (
  candidates: readonly LoadedRefundAttendee[],
  returned: ReadonlySet<string>,
  checkpoint: RefundReadinessBudgetCheckpoint,
): boolean => {
  const cost = refundSubrequestCost(candidates, returned, checkpoint);
  const remaining = getSubrequestRemaining();
  return subrequestCostFits(cost, remaining);
};

const loadedBudgetCandidates = (
  candidates: readonly RefundCandidate[],
): LoadedRefundAttendee[] => candidates.map(loadedRefundAttendee);

const refuseForBudget = <TResult>(
  run: RefundReadinessRun<TResult>,
): TResult => {
  const audience = run.budgetAudience;
  if (audience === undefined) {
    throw new Error("A refund budget refusal had no audience");
  }
  const message = REFUND_BUDGET_MESSAGES[audience];
  return run.notReady(message, "subrequest_budget");
};

/** Claim the exact loaded rows, establish provider readiness, then run them. */
export const runRefundReadiness = async <TResult>(
  run: RefundReadinessRun<TResult>,
): Promise<TResult | BlockedRefundRun> => {
  if (
    run.budgetAudience !== undefined &&
    !budgetFits(
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
      ...(run.budgetAudience === undefined
        ? {}
        : {
            admit: ({ attendees, returned }) =>
              budgetFits(attendees, returned, "inside_claim"),
          }),
      blocked: (block) => {
        if (block.kind === "claim_held") {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        if (block.kind === "not_admitted") return refuseForBudget(run);
        reportCandidateProblems(run, run.candidates, block.reason);
        return run.notReady(run.changedMessage);
      },
      work: async (held) => {
        reconcileSharedReferences(held);
        if (held.shared.size > 0) {
          return run.notReady(reportSharedReference(run, held));
        }
        const admissionProblem = ADMISSION_BY_ACTION[run.action](held);
        if (admissionProblem !== null) {
          reportCandidateProblems(run, run.candidates, admissionProblem);
          return run.notReady(admissionProblem);
        }
        if (
          run.budgetAudience !== undefined &&
          !budgetFits(
            loadedBudgetCandidates(run.candidates),
            held.alreadyReturned,
            "before_provider_read",
          )
        ) {
          return refuseForBudget(run);
        }
        let readiness: RefundReadinessResult;
        try {
          readiness = await run.prepare(
            run.candidates,
            held.claim,
            held.alreadyReturned,
          );
        } catch (error) {
          protectProviderReads(run.candidates, held);
          throw error;
        }
        if (readiness.kind === "not_ready") {
          return run.notReady(
            reportReadinessFailure(run, run.candidates, readiness, held),
          );
        }
        rememberCheckedPhases(held, held.claim);
        return await run.ready(readiness.candidates, held);
      },
    },
  );
};
