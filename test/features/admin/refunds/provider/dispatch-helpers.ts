import {
  type CandidateRefund,
  finishPreparedCandidate,
  prepareReadyCandidate,
  type ReferenceRefund,
} from "#routes/admin/refunds/attempt.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { ReadyRefundCandidate } from "#routes/admin/refunds/readiness.ts";
import type { requestProviderRefund } from "#shared/provider-refunds.ts";

/** Exercise one attendee through the production prepare/finish mechanism. */
export const refundReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  inFlight: Map<string, Promise<ReferenceRefund>> = new Map(),
  request?: typeof requestProviderRefund,
): Promise<CandidateRefund> => {
  const prepared =
    request === undefined
      ? prepareReadyCandidate(candidate, listingId, inFlight)
      : prepareReadyCandidate(candidate, listingId, inFlight, request);
  return await finishPreparedCandidate(prepared, listingId);
};

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
