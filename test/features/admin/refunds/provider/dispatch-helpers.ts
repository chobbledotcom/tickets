import { unique } from "#fp";
import {
  type CandidateRefund,
  finishPreparedCandidate,
  type PreparedReferenceRefund,
  prepareReadyCandidate,
} from "#routes/admin/refunds/attempt.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { ReadyRefundCandidate } from "#routes/admin/refunds/readiness.ts";
import type {
  ArmRefundDispatchResult,
  armRefundDispatch,
} from "#shared/db/payment-refund-dispatch.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";

type AuthorizeRefundDispatch = (
  indexes: readonly string[],
) => Promise<ArmRefundDispatchResult>;

export const authorizeEveryRefund =
  (capability: RefundProviderCapability = "keyed"): AuthorizeRefundDispatch =>
  (indexes) =>
    Promise.resolve({
      kind: "armed",
      permits: new Map(
        indexes.map((index) => [
          index,
          {
            capability,
            commandId: "test-command",
            index,
            kind: "refund_dispatch" as const,
          },
        ]),
      ),
      phases: new Map(),
    });

/** Exercise one attendee through the production prepare/finish mechanism. */
export const refundReadyCandidate = async (
  candidate: ReadyRefundCandidate,
  listingId: number,
  authorize: AuthorizeRefundDispatch,
  inFlight: Map<string, Promise<PreparedReferenceRefund>> = new Map(),
): Promise<CandidateRefund> => {
  const prepared = await prepareReadyCandidate(candidate, listingId, inFlight);
  const indexes = unique(
    prepared.attempts.flatMap((attempt) =>
      attempt.kind === "ready" ? [attempt.reference.index] : [],
    ),
  );
  const authorization =
    indexes.length === 0 ? undefined : await authorize(indexes);
  return await finishPreparedCandidate(prepared, listingId, authorization);
};

export const armEveryRefund =
  (capability: RefundProviderCapability = "keyed"): typeof armRefundDispatch =>
  async ({ held, indexes }) => {
    const result = await authorizeEveryRefund(capability)(indexes);
    if (result.kind !== "armed") throw new Error("test dispatch was refused");
    return {
      ...result,
      phases: new Map(
        [...held.values()]
          .flat()
          .map((sessionId) => [sessionId, "send_armed" as const]),
      ),
    };
  };

export const reviewEveryArmedKeylessRefund =
  (): typeof armRefundDispatch =>
  ({ indexes }) =>
    Promise.resolve({
      indexes,
      kind: "owner_review",
      reason: "uncertain_keyless_refund",
    });

export const holdingClaim = (
  settle: RowClaim["settle"],
  sessions: readonly string[],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      commandId: "test-command",
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      inherited: new Map(),
      kind: "claimed",
      phases: new Map(sessions.map((sessionId) => [sessionId, "checking"])),
      returned: new Set<string>(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    }),
  settle,
});
