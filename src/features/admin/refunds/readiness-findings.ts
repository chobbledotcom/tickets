import { uniqueBy } from "#fp";
import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import {
  type ProviderRefundResult,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import type { RefundCandidate } from "./candidates.ts";
import type { HeldRefundWork } from "./claim.ts";
import { rememberFailedRefundLedger } from "./ledger-findings.ts";
import type {
  RefundReadinessObservation,
  RefundReadinessResult,
} from "./readiness.ts";

type FailedReadiness = Extract<RefundReadinessResult, { kind: "not_ready" }>;

const rememberReturnedForCandidate = (
  candidate: RefundCandidate,
  returnedIndexes: ReadonlySet<string>,
  held: HeldRefundWork,
): void => {
  const attendeeId = candidate.attendee.id;
  const indexes = new Set(returnedIndexes);
  const returned = candidate.references.filter(({ index }) =>
    indexes.has(index)
  );
  if (returned.length > 0) {
    rememberFailedRefundLedger(held.findings, attendeeId, returned);
  }
};

const needsAuthority = ({ charge, identity }: RefundReadinessObservation) =>
  admitObservedRefund(identity.reference, charge).kind !== "send";

const requireMatchingAnswer = (
  observation: RefundReadinessObservation,
  answer: ProviderRefundResult,
): void => {
  if (
    answer.reference.provider !== observation.identity.provider ||
    answer.reference.reference !== observation.identity.reference
  ) {
    throw new Error("Refund authority answered for a different payment");
  }
  if (
    answer.kind === "ready" ||
    answer.kind === "unchanged" ||
    answer.kind === "withheld"
  ) {
    throw new Error("Refund authority discarded observed refund evidence");
  }
};

const reconcileObservedWork = async (
  observations: readonly RefundReadinessObservation[],
  request: typeof requestProviderRefund,
): Promise<ReadonlySet<string>> => {
  const relevant = uniqueBy(
    (observation: RefundReadinessObservation) => observation.reference.index,
  )(observations.filter(needsAuthority));
  const settled = await Promise.allSettled(
    relevant.map(async (observation) => ({
      answer: await request({
        evidence: { charge: observation.charge, kind: "observed" },
        mode: "observe_only",
        reference: observation.identity,
      }),
      observation,
    })),
  );
  const returned = new Set<string>();
  for (const result of settled) {
    if (result.status === "rejected") continue;
    const { answer, observation } = result.value;
    requireMatchingAnswer(observation, answer);
    if (answer.kind === "returned") returned.add(observation.reference.index);
  }
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
  return returned;
};

/** Preserve every money fact a failed complete-read attempt did establish. */
export const rememberReadinessFailureFindings = async (
  candidates: readonly RefundCandidate[],
  readiness: FailedReadiness,
  held: HeldRefundWork,
  request: typeof requestProviderRefund = requestProviderRefund,
): Promise<void> => {
  const returnedIndexes = await reconcileObservedWork(
    readiness.observations,
    request,
  );
  for (const candidate of candidates) {
    rememberReturnedForCandidate(
      candidate,
      returnedIndexes,
      held,
    );
  }
};
