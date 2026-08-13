import { uniqueBy } from "#fp";
import {
  getSubrequestRemaining,
  withSubrequestReserve,
} from "#shared/subrequest-budget.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import {
  type CandidateRefund,
  finishPreparedCandidate,
  type PreparedCandidateRefund,
  prepareReadyCandidate,
  type ReferenceRefund,
  standDownPreparedCandidate,
} from "./attempt.ts";
import {
  type PreparedRefundBudget,
  type RefundDispatchBudgetCheckpoint,
  refundPreparedSubrequestCost,
  type RefundSendBudgetReference,
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
  request: typeof requestProviderRefund,
): Promise<PreparedCandidateRefund[][]> => {
  const inFlight = new Map<string, Promise<ReferenceRefund>>();
  return await Promise.all(
    packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(candidates).map((wave) =>
      Promise.all(
        wave.map((candidate) =>
          prepareReadyCandidate(candidate, listingId, inFlight, request)
        ),
      )
    ),
  );
};

type PreparedRefundAttempt = PreparedCandidateRefund["attempts"][number];

const uniqueAttemptsOf = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
): PreparedRefundAttempt[] =>
  uniqueBy((attempt: PreparedRefundAttempt) => attempt.reference.index)(
    waves.flatMap((wave) => wave.flatMap(({ attempts }) => [...attempts])),
  );

const sendReferencesOf = (
  attempts: readonly PreparedRefundAttempt[],
): RefundSendBudgetReference[] =>
  attempts.flatMap((attempt) =>
    attempt.maySend
      ? [{
        index: attempt.reference.index,
        provider: attempt.reference.provider,
      }]
      : []
  );

const preparedBudgetOf = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
): PreparedRefundBudget => {
  const attempts = uniqueAttemptsOf(waves);
  const returnedAuthorityCount = attempts.filter(
    ({ standDown }) => standDown.outcome === "refunded",
  ).length;
  return {
    activeAuthorityCount: attempts.length - returnedAuthorityCount,
    mayRecordReturns: attempts.some(
      (attempt) => attempt.maySend || attempt.standDown.outcome === "refunded",
    ),
    returnedAuthorityCount,
    sendReferences: sendReferencesOf(attempts),
  };
};

const budgetFits = (
  prepared: PreparedRefundBudget,
  checkpoint: RefundDispatchBudgetCheckpoint,
): boolean => {
  const cost = refundPreparedSubrequestCost(prepared, checkpoint);
  const remaining = getSubrequestRemaining();
  return subrequestCostFits(cost, remaining);
};

/** Carry no-send evidence into settlement without starting local money writes. */
const rememberStandDown = (
  waves: readonly (readonly PreparedCandidateRefund[])[],
  findings: RunFindings,
): void => {
  for (const prepared of waves.flat()) {
    rememberCandidateFindings(findings, standDownPreparedCandidate(prepared));
  }
};

/** Run every admitted provider call before any marker or ledger write begins. */
const sendPreparedWaves = async (
  waves: readonly (readonly PreparedCandidateRefund[])[],
  listingId: number,
): Promise<CandidateRefund[][]> => {
  const sent: CandidateRefund[][] = [];
  const failures: PromiseRejectedResult[] = [];
  for (const wave of waves) {
    const settled = await Promise.allSettled(
      wave.map((prepared) => finishPreparedCandidate(prepared, listingId)),
    );
    failures.push(
      ...settled.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      ),
    );
    sent.push(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      ),
    );
  }
  if (failures.length > 0) throw failures[0]!.reason;
  return sent;
};

/** Prepare the whole batch, protect its allowance, then use the authority. */
export const dispatchRefundBatch = async (
  candidates: readonly ReadyRefundCandidate[],
  listingId: number,
  held: HeldRefundWork,
  request: typeof requestProviderRefund = requestProviderRefund,
): Promise<RefundDispatchBatchResult> => {
  const waves = await prepareWaves(candidates, listingId, request);
  rememberStandDown(waves, held.findings);
  const budget = preparedBudgetOf(waves);
  const references = budget.sendReferences;
  const refuseForBudget = (): RefundDispatchBatchResult => {
    rememberStandDown(waves, held.findings);
    return { kind: "budget_refused" };
  };
  if (!budgetFits(budget, "before_authority_request")) {
    return refuseForBudget();
  }

  return {
    kind: "sent",
    waves: references.length === 0
      ? await sendPreparedWaves(waves, listingId)
      : await withSubrequestReserve(
        refundPreparedSubrequestCost(budget, "inside_authority_request"),
        () => sendPreparedWaves(waves, listingId),
      ),
  };
};
