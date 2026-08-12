import { partition, requiredMapValue } from "#fp";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
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
  candidates: readonly RefundCandidate[];
  changedMessage: string;
  claim: RowClaim;
  executionLimit: number;
  label: string;
  listingId: number;
  notReady: (message: string) => TResult;
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

/** Resume possibly-sent work before starting fresh work. Anything inherited
 * that cannot fit stays held so a later command must reconcile it. */
const refundExecution = (
  candidates: readonly RefundCandidate[],
  held: HeldRefundWork,
  limit: number,
): RefundExecution => {
  const [inherited, fresh] = partition((candidate: RefundCandidate) =>
    held.inherited.has(candidate.attendee.id),
  )([...candidates]);
  const selected = [...inherited, ...fresh].slice(0, limit);
  return {
    candidates: selected,
    claim: claimForExecution(held.claim, selected),
  };
};

/** A resumed send is unsafe until this command observes its provider state. */
const protectInheritedWork = (held: HeldRefundWork): void => {
  for (const attendeeId of held.inherited.keys()) {
    held.findings.doubts.set(attendeeId, "unread");
  }
};

const rememberProviderReadiness = (
  held: HeldRefundWork,
  candidates: readonly RefundCandidate[],
  execution: HeldRefundWork["claim"],
): void => {
  for (const { attendee } of candidates) {
    if (held.inherited.has(attendee.id)) {
      held.findings.doubts.delete(attendee.id);
    }
  }
  for (const [sessionId, phase] of execution.phases) {
    if (phase === "checking") {
      held.findings.claimPhases.set(sessionId, "ready");
    }
  }
};

/** Claim the exact loaded rows, establish provider readiness, then run them. */
export const runRefundReadiness = async <TResult>(
  run: RefundReadinessRun<TResult>,
): Promise<TResult | BlockedRefundRun> =>
  await underAttendeeClaim(
    run.claim,
    run.candidates.map(loadedRefundAttendee),
    run.listingId,
    {
      blocked: ({ kind, reason }) => {
        if (kind === "claim_held") {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        reportCandidateProblems(run, run.candidates, reason);
        return run.notReady(run.changedMessage);
      },
      work: async (held) => {
        protectInheritedWork(held);
        reconcileSharedReferences(held);
        if (held.shared.size > 0) {
          return run.notReady(reportSharedReference(run, held));
        }
        const admissionProblem = ADMISSION_BY_ACTION[run.action](held);
        if (admissionProblem !== null) {
          reportCandidateProblems(run, run.candidates, admissionProblem);
          return run.notReady(admissionProblem);
        }
        const execution = refundExecution(
          run.candidates,
          held,
          run.executionLimit,
        );
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
        rememberProviderReadiness(held, execution.candidates, execution.claim);
        return await run.ready(readiness.candidates, held);
      },
    },
  );
