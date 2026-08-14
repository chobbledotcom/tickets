import { assert } from "@std/assert";
import type {
  CandidateRefund,
  ReferenceRefund,
} from "#routes/admin/refunds/attempt.ts";
import {
  finishPreparedCandidate,
  prepareReadyCandidate,
} from "#routes/admin/refunds/attempt.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { ReadyRefundCandidate } from "#routes/admin/refunds/readiness.ts";
import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import type {
  ProviderRefundResult,
  ProviderRefundTarget,
  RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import type { RecordingProvider } from "./helpers.ts";

const authorityFor = (
  target: ProviderRefundTarget,
): RefundAuthorityReceipt => ({
  id: [...`${target.reference.provider}:${target.reference.reference}`].reduce(
    (id, character, offset) => id + character.codePointAt(0)! * (offset + 1),
    0,
  ),
  referenceIndex: `${target.reference.provider}:${target.reference.reference}`,
  revision: 1,
});

const attemptResult = (
  target: ProviderRefundTarget,
  attempt: RefundAttemptResult,
): ProviderRefundResult => {
  const authority = authorityFor(target);
  if (attempt.kind === "completed") {
    return {
      authority,
      kind: "returned",
      local: "due",
      reference: target.reference,
    };
  }
  if (attempt.kind === "accepted" || attempt.kind === "uncertain") {
    return {
      authority,
      kind: "pending",
      reference: target.reference,
      state: "observing",
    };
  }
  if (attempt.kind === "rejected") {
    return {
      authority,
      kind: "needs_owner_choice",
      reason: "provider_rejected",
      reference: target.reference,
    };
  }
  return { authority, kind: "ready", reference: target.reference };
};

/** A provider-authority boundary double for focused admin orchestration tests. */
export const requestRecordedProviderRefund: typeof requestProviderRefund =
  async (target, dependencies) => {
    if (target.evidence.kind === "read_provider") {
      return {
        authority: authorityFor(target),
        kind: "returned",
        local: "due",
        reference: target.reference,
      };
    }
    assert(
      target.evidence.kind !== "validated_callback",
      "Admin test authority received callback evidence",
    );
    const admission = admitObservedRefund(
      target.reference.reference,
      target.evidence.charge,
    );
    if (admission.kind === "already_returned") {
      return {
        authority: authorityFor(target),
        kind: "returned",
        local: "due",
        reference: target.reference,
      };
    }
    if (target.mode === "observe_only") {
      if (admission.kind === "in_flight") {
        return {
          authority: authorityFor(target),
          kind: "pending",
          reference: target.reference,
          state: "observing",
        };
      }
      if (admission.kind === "refused") {
        return {
          authority: authorityFor(target),
          kind: "needs_owner_choice",
          reason: "provider_conflict",
          reference: target.reference,
        };
      }
      return { kind: "unchanged", reference: target.reference };
    }
    assert(dependencies !== undefined, "Admin test refund lacked dependencies");
    const provider = await dependencies.loadProvider(target.reference.provider);
    return attemptResult(
      target,
      await (provider as RecordingProvider).answerRefund({
        charge: target.evidence.charge,
        paymentReference: target.reference.reference,
      }),
    );
  };

/** Exercise one attendee through the production prepare/finish mechanism. */
export const refundReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inFlight: Map<string, Promise<ReferenceRefund>> = new Map(),
  request: typeof requestProviderRefund = requestRecordedProviderRefund,
): Promise<CandidateRefund> =>
  await finishPreparedCandidate(
    await prepareReadyCandidate(candidate, listingId, inFlight, request),
    listingId,
  );

export const holdingClaim = (
  settle: RowClaim["settle"],
  sessions: readonly string[],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      commandId: "test-command",
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      kind: "claimed",
      phases: new Map(sessions.map((sessionId) => [sessionId, "checking"])),
      returned: new Set<string>(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    }),
  settle,
});
