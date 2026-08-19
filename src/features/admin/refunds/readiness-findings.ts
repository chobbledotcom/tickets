import { uniqueBy } from "#fp";
import { admitObservedRefund } from "#payment/admit-refund.ts";
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
    indexes.has(index),
  );
  if (returned.length > 0) {
    rememberFailedRefundLedger(held.findings, attendeeId, returned);
  }
};

const needsAuthority = ({ charge, identity }: RefundReadinessObservation) =>
  admitObservedRefund(identity.reference, charge).kind !== "send";

type ObservedAuthorityAnswer = Extract<
  ProviderRefundResult,
  {
    kind:
      | "needs_owner_choice"
      | "needs_provider_check"
      | "pending"
      | "returned";
  }
>;

const PRESERVES_OBSERVED_EVIDENCE = {
  changed: false,
  needs_owner_choice: true,
  needs_provider_check: true,
  pending: true,
  ready: false,
  returned: true,
  unchanged: false,
  withheld: false,
} as const satisfies Record<ProviderRefundResult["kind"], boolean>;

type RequireMatchingAnswer = (
  observation: RefundReadinessObservation,
  answer: ProviderRefundResult,
) => asserts answer is ObservedAuthorityAnswer;

const requireMatchingAnswer: RequireMatchingAnswer = (observation, answer) => {
  if (
    answer.reference.provider !== observation.identity.provider ||
    answer.reference.reference !== observation.identity.reference
  ) {
    throw new Error("Refund authority answered for a different payment");
  }
  if (!PRESERVES_OBSERVED_EVIDENCE[answer.kind]) {
    throw new Error("Refund authority discarded observed refund evidence");
  }
};

type ReconciledObservedWork =
  | { kind: "complete"; returned: ReadonlySet<string> }
  | { error: unknown; kind: "failed"; returned: ReadonlySet<string> };

const reconcileObservedWork = async (
  observations: readonly RefundReadinessObservation[],
  request: typeof requestProviderRefund,
): Promise<ReconciledObservedWork> => {
  const relevant = uniqueBy(
    (observation: RefundReadinessObservation) => observation.reference.index,
  )(observations.filter(needsAuthority));
  // The provider read is already money evidence. Remember a completed return
  // before asking local authority storage to catch up, because that write is
  // allowed to fail and must not erase what the provider told us.
  const returned = new Set(
    relevant.flatMap((observation) =>
      admitObservedRefund(observation.identity.reference, observation.charge)
        .kind === "already_returned"
        ? [observation.reference.index]
        : [],
    ),
  );
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
  for (const result of settled) {
    if (result.status === "rejected") continue;
    const { answer, observation } = result.value;
    requireMatchingAnswer(observation, answer);
    if (answer.kind === "returned") returned.add(observation.reference.index);
  }
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  return failure === undefined
    ? { kind: "complete", returned }
    : { error: failure.reason, kind: "failed", returned };
};

/** Preserve every money fact a failed complete-read attempt did establish. */
export const rememberReadinessFailureFindings = async (
  candidates: readonly RefundCandidate[],
  readiness: FailedReadiness,
  held: HeldRefundWork,
  request: typeof requestProviderRefund = requestProviderRefund,
): Promise<void> => {
  const reconciliation = await reconcileObservedWork(
    readiness.observations,
    request,
  );
  for (const candidate of candidates) {
    rememberReturnedForCandidate(candidate, reconciliation.returned, held);
  }
  if (reconciliation.kind === "failed") throw reconciliation.error;
};
