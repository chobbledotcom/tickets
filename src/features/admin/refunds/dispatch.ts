import { groupToMap, requiredMapValue, uniqueBy } from "#fp";
import type {
  ArmRefundDispatchResult,
  armRefundDispatch,
} from "#shared/db/payment-refund-dispatch.ts";
import { getSubrequestRemaining } from "#shared/subrequest-budget.ts";
import {
  type CandidateRefund,
  finishPreparedCandidate,
  type PreparedCandidateRefund,
  type PreparedReferenceRefund,
  prepareReadyCandidate,
  standDownPreparedCandidate,
} from "./attempt.ts";
import {
  type RefundDispatchBudgetCheckpoint,
  type RefundSendBudgetReference,
  refundPreparedSubrequestCost,
  subrequestCostFits,
} from "./budget.ts";
import type { HeldRefundWork, RunFindings } from "./claim.ts";
import { PROVIDER_REFUND_CONCURRENCY } from "./provider-requests.ts";
import type { ReadyRefundCandidate } from "./readiness.ts";
import { rememberCandidateFindings } from "./result-findings.ts";
import { packByReferenceCount } from "./waves.ts";

export type RefundDispatchBatchResult =
  | { readonly kind: "budget_refused" }
  | {
      readonly kind: "sent";
      readonly waves: readonly (readonly CandidateRefund[])[];
    };

const prepareWaves = async (
  candidates: readonly ReadyRefundCandidate[],
  listingId: number,
): Promise<PreparedCandidateRefund[][]> => {
  const inFlight = new Map<string, Promise<PreparedReferenceRefund>>();
  return await Promise.all(
    packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(candidates).map((wave) =>
      Promise.all(
        wave.map((candidate) =>
          prepareReadyCandidate(candidate, listingId, inFlight),
        ),
      ),
    ),
  );
};

const sendReferencesOf = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
): RefundSendBudgetReference[] =>
  uniqueBy((reference: RefundSendBudgetReference) => reference.index)(
    waves.flatMap((wave) =>
      wave.flatMap(({ attempts }) =>
        attempts.flatMap((attempt) =>
          attempt.kind === "ready"
            ? [
                {
                  index: attempt.reference.index,
                  provider: attempt.reference.provider,
                },
              ]
            : [],
        ),
      ),
    ),
  );

const budgetFits = (
  references: readonly RefundSendBudgetReference[],
  checkpoint: RefundDispatchBudgetCheckpoint,
): boolean =>
  subrequestCostFits(
    refundPreparedSubrequestCost(references, checkpoint),
    getSubrequestRemaining(),
  );

const attendeesByReference = (
  candidates: readonly ReadyRefundCandidate[],
): ReadonlyMap<string, readonly number[]> =>
  groupToMap(
    (entry: { attendeeId: number; index: string }) => entry.index,
    (entry) => entry.attendeeId,
  )(
    candidates.flatMap((candidate) =>
      candidate.references.map(({ reference }) => ({
        attendeeId: candidate.attendee.id,
        index: reference.index,
      })),
    ),
  );

const rememberArmed = (
  authorization: Extract<ArmRefundDispatchResult, { kind: "armed" }>,
  references: readonly RefundSendBudgetReference[],
  attendees: ReadonlyMap<string, readonly number[]>,
  findings: RunFindings,
): void => {
  for (const [sessionId, phase] of authorization.phases) {
    findings.claimPhases.set(sessionId, phase);
  }
  for (const { index } of references) {
    for (const attendeeId of requiredMapValue(
      attendees,
      index,
      `Refund dispatch lost payment ${index}'s attendees`,
    )) {
      findings.doubts.set(attendeeId, "in_doubt");
    }
  }
};

/** Carry no-send evidence into settlement without starting local money writes. */
const rememberStandDown = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
  findings: RunFindings,
  protectedAttendees: ReadonlySet<number>,
): void => {
  for (const prepared of waves.flat()) {
    const result = standDownPreparedCandidate(prepared);
    const attendeeId = result.candidate.attendee.id;
    rememberCandidateFindings(findings, result, {
      doubt: protectedAttendees.has(attendeeId) ? "keep" : "replace",
    });
  }
};

/** Remember provider-free answers before any send in the batch can fail. */
const rememberPreparedEvidence = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
  findings: RunFindings,
): void => {
  for (const prepared of waves.flat()) {
    rememberCandidateFindings(findings, standDownPreparedCandidate(prepared), {
      doubt: "merge",
    });
  }
};

/** Run every admitted provider call before any marker or ledger write begins. */
const sendPreparedWaves = async (
  waves: readonly (readonly PreparedCandidateRefund[])[],
  listingId: number,
  authorization: ArmRefundDispatchResult | undefined,
): Promise<CandidateRefund[][]> => {
  const sent: CandidateRefund[][] = [];
  const failures: PromiseRejectedResult[] = [];
  for (const wave of waves) {
    const settled = await Promise.allSettled(
      wave.map((prepared) =>
        finishPreparedCandidate(prepared, listingId, authorization),
      ),
    );
    failures.push(
      ...settled.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      ),
    );
    sent.push(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    );
  }
  if (failures.length > 0) throw failures[0]!.reason;
  return sent;
};

/** Prepare the whole batch, arm its exact send set once, then dispatch it. */
export const dispatchRefundBatch = async (
  candidates: readonly ReadyRefundCandidate[],
  listingId: number,
  held: HeldRefundWork,
  arm: typeof armRefundDispatch,
): Promise<RefundDispatchBatchResult> => {
  const waves = await prepareWaves(candidates, listingId);
  rememberPreparedEvidence(waves, held.findings);
  const references = sendReferencesOf(waves);
  const refuseForBudget = (): RefundDispatchBatchResult => {
    rememberStandDown(waves, held.findings, new Set(held.inherited.keys()));
    return { kind: "budget_refused" };
  };
  if (!budgetFits(references, "before_dispatch_arm")) {
    return refuseForBudget();
  }

  const authorization =
    references.length === 0
      ? undefined
      : await arm({
          ...held.claim,
          indexes: references.map(({ index }) => index),
        });
  if (authorization?.kind === "armed") {
    rememberArmed(
      authorization,
      references,
      attendeesByReference(candidates),
      held.findings,
    );
    if (!budgetFits(references, "before_provider_send")) {
      return refuseForBudget();
    }
  }

  return {
    kind: "sent",
    waves: await sendPreparedWaves(waves, listingId, authorization),
  };
};
