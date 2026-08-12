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

type RefundReadinessRun<TResult> = {
  candidates: readonly RefundCandidate[];
  changedMessage: string;
  claim: RowClaim;
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

const reportCandidateProblems = (
  run: RefundReadinessRun<unknown>,
  message: string,
): void => {
  for (const candidate of run.candidates) {
    reportRefundProblem(
      `${run.label} not started for attendee ${candidate.attendee.id}: ${message}`,
      run.listingId,
    );
  }
};

/** Record why a claimed run could not establish complete provider evidence. */
const reportReadinessFailure = (
  run: RefundReadinessRun<unknown>,
  readiness: FailedReadiness,
  held: HeldRefundWork,
): string => {
  const message = refundReadinessMessage(readiness);
  for (const candidate of run.candidates) {
    const attendeeId = candidate.attendee.id;
    if (readiness.reason !== "historical_marker") {
      held.findings.doubts.set(attendeeId, "unread");
    }
  }
  reportCandidateProblems(run, message);
  return message;
};

/** Park every exact representation before provider preparation can run. */
const reportSharedReference = (
  run: RefundReadinessRun<unknown>,
  held: HeldRefundWork,
): string => {
  const sessionIds = new Set(
    [...held.shared.values()].flatMap((representations) =>
      representations.map(({ sessionId }) => sessionId),
    ),
  );
  for (const sessionId of sessionIds) {
    held.findings.reviews.set(sessionId, {
      kind: "review",
      reason: { kind: "shared_reference" },
    });
  }
  reportCandidateProblems(run, SHARED_REFERENCE_MESSAGE);
  return SHARED_REFERENCE_MESSAGE;
};

/** Claim the exact loaded rows, establish provider readiness, then run them. */
export const runRefundReadiness = async <TResult>(
  run: RefundReadinessRun<TResult>,
): Promise<TResult | BlockedRefundRun> =>
  await underAttendeeClaim(
    run.claim,
    run.candidates.map(loadedRefundAttendee),
    "unresolved",
    run.listingId,
    {
      blocked: ({ kind, reason }) => {
        if (kind === "claim_held") {
          return { kind: "blocked", reason: "refund_in_progress" };
        }
        reportCandidateProblems(run, reason);
        return run.notReady(run.changedMessage);
      },
      work: async (held) => {
        if (held.shared.size > 0) {
          return run.notReady(reportSharedReference(run, held));
        }
        const readiness = await run.prepare(
          run.candidates,
          held.claim,
          held.alreadyReturned,
        );
        return readiness.kind === "not_ready"
          ? run.notReady(reportReadinessFailure(run, readiness, held))
          : await run.ready(readiness.candidates, held);
      },
    },
  );
