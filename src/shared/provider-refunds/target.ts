/** Load and prepare exactly one canonical refund target. */

/* jscpd:ignore-start -- imports */
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import {
  bindRefundCallbackIfChargeExists,
  createOrLoadRefundAuthority,
  loadRefundAuthorityByReference,
  type RefundAuthorityRow,
} from "#shared/db/provider-refund-authority.ts";
import type { Money } from "#shared/payment/money.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import {
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

interface LoadedRefundTarget {
  readonly callbackReplayIndex: string | undefined;
  readonly existing: RefundAuthorityRow | null;
  readonly kind: "loaded";
}

type RefundTargetLoad = LoadedRefundTarget | { readonly kind: "changed" };

const callbackBinding = (
  callbackReplayIndex: string | undefined,
): { readonly callbackReplayIndex?: string } => {
  if (callbackReplayIndex === undefined) return {};
  return { callbackReplayIndex };
};

export const loadRefundTarget = async (
  target: ProviderRefundTarget,
): Promise<RefundTargetLoad> => {
  const referenceIndex = await paymentReferenceIndex(target.reference);
  if (target.callbackSessionId === undefined) {
    const existing = await loadRefundAuthorityByReference(referenceIndex);
    if (
      target.authority !== undefined &&
      (existing === null ||
        existing.id !== target.authority.id ||
        existing.revision !== target.authority.revision)
    ) {
      return { kind: "changed" };
    }
    return {
      callbackReplayIndex: undefined,
      existing,
      kind: "loaded",
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
    kind: "loaded",
  };
};

export const answerKnownRefund = (
  target: ProviderRefundTarget,
  existing: RefundAuthorityRow | null,
): ProviderRefundResult | null => {
  if (
    existing?.state.kind === "completed" ||
    (existing?.state.kind === "needs_owner_choice" && target.mode === "send") ||
    (existing?.state.kind === "needs_provider_check" && target.mode === "send")
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
    captured,
    now,
    reference: target.reference,
    state: await initialRefundState(target.reference, provider, now),
  });
};

/** A validated callback establishes captured money before a flaky provider
 * read. The read still gates every send. */
export const prepareTargetAuthority = async (
  target: ProviderRefundTarget,
  loaded: LoadedRefundTarget,
  provider: RefundEngineProvider,
  now: number,
): Promise<RefundAuthorityRow | null> => {
  if (target.evidence.kind !== "validated_callback") {
    return loaded.existing;
  }
  return await createTargetAuthority(
    target,
    loaded,
    provider,
    target.evidence.captured,
    now,
  );
};
