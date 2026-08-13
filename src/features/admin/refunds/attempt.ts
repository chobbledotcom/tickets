/* jscpd:ignore-start -- imports */
import type {
  ObservedRefundAdmission,
  WithheldRefund,
} from "#shared/payment/admit-refund.ts";
import {
  type ProviderRefundResult,
  type RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { requestReadyRefund } from "./authority.ts";
import { mapProviderRequests } from "./provider-requests.ts";
import type {
  ReadyRefundCandidate,
  ReadyRefundProvider,
  ReadyRefundReference,
} from "./readiness.ts";
import { readyRefundAdmission } from "./ready-admission.ts";
import { reportRefundProblem } from "./report.ts";
import { combineRefundOutcomes, type RefundOutcome } from "./waves.ts";
/* jscpd:ignore-end */

type TaggedRefundReference = ReadyRefundReference["reference"];
type ObservedWithheldRefund = WithheldRefund;
type RefundReportFacts = {
  readonly attendeeId: number;
  readonly listingId: number;
  readonly provider: ReadyRefundProvider["type"];
};

/** One reference's result. A returned result names the durable authority that
 * must be retired only after its local ledger write succeeds. */
export type ReferenceRefund =
  | {
    readonly authority: RefundAuthorityReceipt;
    readonly outcome: "refunded";
  }
  | {
    readonly outcome: Exclude<RefundOutcome, "refunded">;
  };

type ReferenceStandDown = {
  readonly outcome: RefundOutcome;
};

export type PreparedReferenceRefund = {
  maySend: boolean;
  run: (mode: "observe_only" | "send") => Promise<ReferenceRefund>;
  standDown: ReferenceStandDown;
};

export type PreparedRefundAttempt = PreparedReferenceRefund & {
  readonly reference: TaggedRefundReference;
};

export type PreparedCandidateRefund = {
  readonly attempts: readonly PreparedRefundAttempt[];
  readonly candidate: ReadyRefundCandidate;
};

/** Do the work at most once per stable provider-aware identity. */
const answeredOnce = <TAnswer>(
  asked: Map<string, Promise<TAnswer>>,
  index: string,
  ask: () => Promise<TAnswer>,
): Promise<TAnswer> => {
  const started = asked.get(index);
  if (started !== undefined) return started;
  const running = ask();
  asked.set(index, running);
  return running;
};

const withheldResult = (
  admission: ObservedWithheldRefund,
  report: RefundReportFacts,
): ReferenceStandDown => {
  if (admission.kind === "already_returned") return { outcome: "refunded" };
  reportWithheldRefund(admission, report);
  return { outcome: admission.kind === "refused" ? "withheld" : "pending" };
};

const standDownResult = (
  admission: ObservedRefundAdmission,
  report: RefundReportFacts,
): ReferenceStandDown =>
  admission.kind === "send"
    ? { outcome: "failed" }
    : withheldResult(admission, report);

const engineResult = (
  result: ProviderRefundResult,
  attendeeId: number,
  listingId: number,
): ReferenceRefund => {
  if (result.kind === "returned") {
    return { authority: result.authority, outcome: "refunded" };
  }
  if (result.kind === "pending") {
    return { outcome: "pending" };
  }
  if (result.kind === "withheld") {
    const withheld = withheldResult(
      result.admission,
      { attendeeId, listingId, provider: result.reference.provider },
    );
    if (withheld.outcome === "refunded") {
      throw new Error("Refund authority withheld a completed refund");
    }
    return { outcome: withheld.outcome };
  }
  if (result.kind === "needs_owner_choice") {
    return {
      outcome: result.reason === "provider_rejected" ? "failed" : "pending",
    };
  }
  if (result.kind === "unchanged") return { outcome: "withheld" };
  return { outcome: "withheld" };
};

const askAuthority = (
  ready: ReadyRefundReference,
  attendeeId: number,
  listingId: number,
  mode: "observe_only" | "send",
  request: typeof requestProviderRefund,
): Promise<ReferenceRefund> =>
  requestReadyRefund(ready, mode, request).then((result) =>
    engineResult(result, attendeeId, listingId)
  );

const prepareReferenceRefund = (
  candidate: ReadyRefundCandidate,
  listingId: number,
  ready: ReadyRefundReference,
  inFlight: Map<string, Promise<ReferenceRefund>>,
  request: typeof requestProviderRefund,
): PreparedReferenceRefund => {
  const admission = readyRefundAdmission(ready);
  return {
    maySend: admission.kind === "send",
    run: (mode) =>
      answeredOnce(inFlight, ready.reference.index, () =>
        askAuthority(
          ready,
          candidate.attendee.id,
          listingId,
          mode,
          request,
        )),
    standDown: standDownResult(
      admission,
      {
        attendeeId: candidate.attendee.id,
        listingId,
        provider: ready.provider.type,
      },
    ),
  };
};

export type ReturnedRefundReference = {
  readonly authority: RefundAuthorityReceipt;
  readonly reference: TaggedRefundReference;
};

export type CandidateRefund = {
  candidate: ReadyRefundCandidate;
  outcome: RefundOutcome;
  returned: readonly ReturnedRefundReference[];
};

/** Decide every reference without starting a provider send. */
export const prepareReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inFlight: Map<string, Promise<ReferenceRefund>> = new Map(),
  request: typeof requestProviderRefund = requestProviderRefund,
): Promise<PreparedCandidateRefund> => {
  const prepared = await mapProviderRequests(
    candidate.references,
    async (ready): Promise<PreparedRefundAttempt> => ({
      ...prepareReferenceRefund(candidate, listingId, ready, inFlight, request),
      reference: ready.reference,
    }),
  );
  return {
    attempts: prepared,
    candidate,
  };
};

type ReferenceRefundResult = ReferenceRefund & {
  readonly reference: TaggedRefundReference;
};

const candidateResult = (
  prepared: PreparedCandidateRefund,
  results: readonly ReferenceRefundResult[],
  incompleteListingId?: number,
): CandidateRefund => {
  const outcome = combineRefundOutcomes(results.map(({ outcome }) => outcome));
  const returned = results.flatMap((result) =>
    result.outcome === "refunded"
      ? [{ authority: result.authority, reference: result.reference }]
      : []
  );
  if (
    incompleteListingId !== undefined &&
    outcome === "failed" &&
    prepared.candidate.references.length > 1
  ) {
    reportRefundProblem(
      {
        attendeeId: prepared.candidate.attendee.id,
        kind: "incomplete_batch",
        paymentCount: prepared.candidate.references.length,
      },
      incompleteListingId,
    );
  }
  return {
    candidate: prepared.candidate,
    outcome,
    returned,
  };
};

/** Finish one prepared attendee through the durable provider authority. */
export const finishPreparedCandidate = async (
  prepared: PreparedCandidateRefund,
  listingId: number,
): Promise<CandidateRefund> => {
  const mode = prepared.attempts.some(
      (attempt) =>
        !attempt.maySend &&
        attempt.standDown.outcome !== "refunded",
    )
    ? "observe_only"
    : "send";
  const results = await mapProviderRequests(
    prepared.attempts,
    async (attempt): Promise<ReferenceRefundResult> => ({
      ...await attempt.run(mode),
      reference: attempt.reference,
    }),
  );
  return candidateResult(prepared, results, listingId);
};

/** Preserve provider-free evidence when a prepared batch stands down. */
export const standDownPreparedCandidate = (
  prepared: PreparedCandidateRefund,
): CandidateRefund => ({
  candidate: prepared.candidate,
  outcome: combineRefundOutcomes(
    prepared.attempts.map(({ standDown }) => standDown.outcome),
  ),
  // A provider-free refusal has no authority answer to retire. Canonical
  // completed rows are already protected by the claim's initial findings.
  returned: [],
});
