/** Load and prepare exactly one canonical refund target. */

/* jscpd:ignore-start -- imports */
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import {
  bindRefundCallbackIfChargeExists,
  createOrLoadRefundAuthority,
  loadRefundAuthorityByReference,
  type RefundAuthorityRow,
} from "#shared/db/provider-refund-authority.ts";
import { type Money, sameMoney } from "#shared/payment/money.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import {
  answerProviderConflict,
  initialRefundState,
  moveRefundToOwner,
  ownerReasonWhenDue,
  REFUND_OBSERVATION_DELAY_MS,
  refundAnswerFrom,
} from "#shared/provider-refunds/state.ts";
import type {
  ProviderRefundResult,
  ProviderRefundTarget,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
/* jscpd:ignore-end */

export interface LoadedRefundTarget {
  readonly callbackReplayIndex: string | undefined;
  readonly existing: RefundAuthorityRow | null;
}

const callbackBinding = (
  callbackReplayIndex: string | undefined,
): { readonly callbackReplayIndex?: string } => {
  if (callbackReplayIndex === undefined) return {};
  return { callbackReplayIndex };
};

export const loadRefundTarget = async (
  target: ProviderRefundTarget,
): Promise<LoadedRefundTarget> => {
  const referenceIndex = await paymentReferenceIndex(target.reference);
  if (target.callbackSessionId === undefined) {
    return {
      callbackReplayIndex: undefined,
      existing: await loadRefundAuthorityByReference(referenceIndex),
    };
  }
  const callbackReplayIndex = await refundCallbackReplayIndex(
    target.reference.provider,
    target.callbackSessionId,
  );
  return {
    callbackReplayIndex,
    existing: await bindRefundCallbackIfChargeExists({
      callbackReplayIndex,
      referenceIndex,
    }),
  };
};

export const answerKnownRefund = (
  target: ProviderRefundTarget,
  existing: RefundAuthorityRow | null,
): ProviderRefundResult | null => {
  if (
    existing?.state.kind === "completed" ||
    (existing?.state.kind === "needs_owner_choice" && target.mode === "send")
  ) {
    return refundAnswerFrom(existing, target.reference);
  }
  return null;
};

export const answerUnreadableRefund = async (
  target: ProviderRefundTarget,
  existing: RefundAuthorityRow | null,
  read: Exclude<
    Awaited<ReturnType<RefundEngineProvider["readCharge"]>>,
    { status: "found" }
  >,
  now: number,
): Promise<ProviderRefundResult> => {
  if (
    existing?.state.kind === "ready" &&
    (read.status !== "unavailable" ||
      now >= existing.state.readyAt + REFUND_OBSERVATION_DELAY_MS)
  ) {
    return await moveRefundToOwner(
      existing,
      "provider_unreadable",
      now,
      target.reference,
      existing.refunded,
    );
  }
  if (
    existing !== null &&
    (existing.state.kind === "send_armed" ||
      existing.state.kind === "observing")
  ) {
    const reason = ownerReasonWhenDue(existing.state, now);
    if (reason !== null) {
      return await moveRefundToOwner(
        existing,
        reason,
        now,
        target.reference,
        existing.refunded,
      );
    }
  }
  return {
    admission: { kind: "read_failed", read },
    kind: "withheld",
    reference: target.reference,
  };
};

export const createTargetAuthority = async (
  target: ProviderRefundTarget,
  loaded: LoadedRefundTarget,
  provider: RefundEngineProvider,
  captured: Money,
  now: number,
): Promise<RefundAuthorityRow> => {
  if (loaded.existing !== null) return loaded.existing;
  return await createOrLoadRefundAuthority({
    ...callbackBinding(loaded.callbackReplayIndex),
    capability: provider.refundCapability,
    captured,
    now,
    reference: target.reference,
    state: await initialRefundState(target.reference, provider, now),
  });
};

export type PreparedTargetAuthority =
  | { readonly kind: "continue"; readonly row: RefundAuthorityRow | null }
  | { readonly kind: "answered"; readonly result: ProviderRefundResult };

/** A validated callback establishes captured money before a flaky provider
 * read. The read still gates every send. */
export const prepareTargetAuthority = async (
  target: ProviderRefundTarget,
  loaded: LoadedRefundTarget,
  provider: RefundEngineProvider,
  now: number,
): Promise<PreparedTargetAuthority> => {
  if (target.evidence.kind !== "validated_callback") {
    return { kind: "continue", row: loaded.existing };
  }
  const row = await createTargetAuthority(
    target,
    loaded,
    provider,
    target.evidence.captured,
    now,
  );
  if (sameMoney(row.captured, target.evidence.captured)) {
    return { kind: "continue", row };
  }
  return {
    kind: "answered",
    result: await answerProviderConflict(row, now, target.reference),
  };
};
