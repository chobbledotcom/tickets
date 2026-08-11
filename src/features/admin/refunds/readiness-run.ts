import type { RefundCandidate } from "./candidates.ts";
import { loadedRefundAttendee } from "./candidates.ts";
import {
  type HeldRefundWork,
  type RowClaim,
  underAttendeeClaim,
} from "./claim.ts";
import {
  type ReadyRefundCandidate,
  type RefundReadinessResult,
} from "./readiness.ts";
import { refundReadinessMessage } from "./readiness-problem.ts";
import { reportRefundProblem } from "./report.ts";

type FailedReadiness = Extract<RefundReadinessResult, { kind: "not_ready" }>;
type BlockedRefundRun = { kind: "blocked"; reason: "refund_in_progress" };

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
    reportRefundProblem(
      `${run.label} not started for attendee ${attendeeId}: ${message}`,
      run.listingId,
    );
  }
  return message;
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
        for (const candidate of run.candidates) {
          reportRefundProblem(
            `${run.label} not started for attendee ${candidate.attendee.id}: ${reason}`,
            run.listingId,
          );
        }
        return run.notReady(run.changedMessage);
      },
      work: async (held) => {
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
