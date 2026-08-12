import { requiredMapValue } from "#fp";
import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import { getSubrequestRemaining } from "#shared/subrequest-budget.ts";
import {
  carriesHeldRefundRows,
  REFUND_BUDGET_MESSAGES,
  type RefundBudgetAudience,
  type RefundReadinessBudgetCheckpoint,
  refundSubrequestCost,
  selectRefundExecutionCandidates,
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
  executionLimit: number;
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
  for (const candidate of candidates) {
    const attendeeId = candidate.attendee.id;
    if (readiness.reason !== "historical_marker") {
      held.findings.doubts.set(attendeeId, "unread");
    }
  }
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

const claimForExecution = (
  claim: HeldRefundWork["claim"],
  candidates: readonly RefundCandidate[],
): HeldRefundWork["claim"] => {
  const attendeeIds = new Set(candidates.map(({ attendee }) => attendee.id));
  const held = new Map(
    [...claim.held].filter(([attendeeId]) => attendeeIds.has(attendeeId)),
  );
  const sessionIds = [...held.values()].flat();
  return {
    ...claim,
    held,
    phases: new Map(
      sessionIds.map((sessionId) => [
        sessionId,
        requiredMapValue(
          claim.phases,
          sessionId,
          `Refund admission omitted payment row ${sessionId}`,
        ),
      ]),
    ),
  };
};

type RefundExecution = {
  readonly candidates: readonly RefundCandidate[];
  readonly claim: HeldRefundWork["claim"];
};

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
): LoadedRefundAttendee[] =>
  candidates.map((candidate) => ({
    ...loadedRefundAttendee(candidate),
    held: carriesHeldRefundRows(candidate),
  }));

const executionCandidatesFor = (
  candidates: readonly RefundCandidate[],
  limit: number,
  inherited?: ReadonlySet<number>,
): RefundCandidate[] =>
  selectRefundExecutionCandidates(
    candidates.map((candidate) => ({
      attendeeId: candidate.attendee.id,
      candidate,
      references: candidate.references,
    })),
    limit,
    inherited,
  ).map(({ candidate }) => candidate);

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
  const executionCandidates = executionCandidatesFor(
    run.candidates,
    run.executionLimit,
  );
  if (
    run.budgetAudience !== undefined &&
    !budgetFits(
      loadedBudgetCandidates(executionCandidates),
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
            admit: ({ attendees, inherited, returned }) =>
              budgetFits(
                selectRefundExecutionCandidates(
                  attendees,
                  run.executionLimit,
                  new Set(inherited.keys()),
                ),
                returned,
                "inside_claim",
              ),
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
        const exactExecutionCandidates = executionCandidatesFor(
          run.candidates,
          run.executionLimit,
          new Set(held.inherited.keys()),
        );
        if (
          run.budgetAudience !== undefined &&
          !budgetFits(
            loadedBudgetCandidates(exactExecutionCandidates),
            held.alreadyReturned,
            "before_provider_read",
          )
        ) {
          return refuseForBudget(run);
        }
        const execution: RefundExecution = {
          candidates: exactExecutionCandidates,
          claim: claimForExecution(held.claim, exactExecutionCandidates),
        };
        const readiness = await run.prepare(
          execution.candidates,
          execution.claim,
          held.alreadyReturned,
        );
        if (readiness.kind === "not_ready") {
          return run.notReady(
            reportReadinessFailure(run, execution.candidates, readiness, held),
          );
        }
        rememberCheckedPhases(held, execution.claim);
        return await run.ready(readiness.candidates, held);
      },
    },
  );
};
