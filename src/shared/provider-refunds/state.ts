/** Evidence-to-state transitions shared by initial work and later retries. */

/* jscpd:ignore-start -- imports */
import {
  completeRefundAuthority,
  loadRefundAuthorityById,
  type RefundAuthorityRow,
  transitionRefundAuthority,
} from "#shared/db/provider-refund-authority.ts";
import type { Money } from "#shared/payment/money.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundObservationDue,
  type RefundAuthorityState,
  type RefundRequestGeneration,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { markRefundOwnerChoiceNeeded } from "#shared/payment/refund-authority-choice.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#shared/payment/refund-provider-authorization.ts";
import { refundReplayUntil } from "#shared/payment/refund-replay-window.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import {
  type ChargeMoney,
  refundMoneyReturned,
} from "#shared/payment/resources.ts";
import type {
  ProviderRefundResult,
  ProviderRefundTarget,
  RefundAuthorityReceipt,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
/* jscpd:ignore-end */

export const REFUND_OBSERVATION_DELAY_MS = 5 * 60 * 1000;

const receipt = (row: RefundAuthorityRow): RefundAuthorityReceipt => ({
  id: row.id,
  referenceIndex: row.referenceIndex,
  revision: row.revision,
});

export const refundAnswerFrom = (
  row: RefundAuthorityRow,
  reference: TaggedPaymentReference,
): ProviderRefundResult => {
  if (row.state.kind === "completed") {
    return {
      authority: receipt(row),
      kind: "returned",
      local: row.state.local.kind === "due" ? "due" : "recorded",
      reference,
    };
  }
  if (row.state.kind === "needs_owner_choice") {
    return {
      authority: receipt(row),
      kind: "needs_owner_choice",
      reason: row.state.reason,
      reference,
    };
  }
  if (row.state.kind === "ready") {
    return { authority: receipt(row), kind: "ready", reference };
  }
  return {
    authority: receipt(row),
    kind: "pending",
    reference,
    state: row.state.kind,
  };
};

export const requireCurrentRefund = async (
  row: RefundAuthorityRow,
): Promise<RefundAuthorityRow> => {
  const current = await loadRefundAuthorityById(row.id);
  if (current === null) throw new Error("Refund authority disappeared");
  return current;
};

export const refundAfterTransition = async (
  changed: RefundAuthorityRow | null,
  previous: RefundAuthorityRow,
  reference: TaggedPaymentReference,
): Promise<ProviderRefundResult> =>
  refundAnswerFrom(
    changed ?? (await requireCurrentRefund(previous)),
    reference,
  );

export const returnedRefundMoney = (charge: ChargeMoney): Money => ({
  amount: refundMoneyReturned(charge),
  currency: charge.captured.currency,
});

const requestGeneration = async (
  reference: TaggedPaymentReference,
  capability: RefundEngineProvider["refundCapability"],
  generation: number,
  now: number,
): Promise<RefundRequestGeneration> => {
  const identityIndex = await refundRequestIdentityIndex(reference, generation);
  return capability === "keyless"
    ? { capability, generation, identityIndex }
    : {
        capability,
        generation,
        identityIndex,
        replayUntil: refundReplayUntil(reference.provider, now),
      };
};

export const initialRefundState = async (
  reference: TaggedPaymentReference,
  provider: RefundEngineProvider,
  now: number,
): Promise<Extract<RefundAuthorityState, { kind: "ready" }>> => {
  const request = await requestGeneration(
    reference,
    provider.refundCapability,
    1,
    now,
  );
  return readyRefund({
    evidenceRevision: 1,
    nextActionAt: now,
    now,
    request,
  });
};

export const requireMatchingRefundProvider = (
  provider: RefundEngineProvider,
  reference: TaggedPaymentReference,
): void => {
  if (
    provider.type !== reference.provider ||
    provider.refundCapability !==
      REFUND_PROVIDER_CAPABILITIES[reference.provider]
  ) {
    throw new Error("Refund provider does not match its durable identity");
  }
};

export const readRefundEvidence = async (
  target: ProviderRefundTarget,
  provider: RefundEngineProvider,
): Promise<ProviderRead<ChargeMoney>> =>
  target.evidence.kind === "observed"
    ? { resource: target.evidence.charge, status: "found" }
    : await provider.readCharge(target.reference.reference);

export const ownerReasonWhenDue = (
  state: Extract<RefundAuthorityState, { kind: "observing" | "send_armed" }>,
  now: number,
): "possibly_sent" | "replay_window_expired" | null =>
  now < state.nextActionAt
    ? null
    : state.request.capability === "keyless"
      ? "possibly_sent"
      : now > state.request.replayUntil
        ? "replay_window_expired"
        : null;

export const moveRefundToOwner = async (
  row: RefundAuthorityRow,
  reason: Extract<
    RefundAuthorityState,
    { kind: "needs_owner_choice" }
  >["reason"],
  now: number,
  reference: TaggedPaymentReference,
  refunded: Money,
): Promise<ProviderRefundResult> =>
  await refundAfterTransition(
    await transitionRefundAuthority(row, now, refunded, (state) =>
      markRefundOwnerChoiceNeeded(state, now, reason),
    ),
    row,
    reference,
  );

type AnswerRefund = (
  row: RefundAuthorityRow,
  now: number,
  reference: TaggedPaymentReference,
) => Promise<ProviderRefundResult>;

/** Preserve terminal work, or turn a live disagreement into an owner choice. */
export const answerProviderConflict: AnswerRefund = async (
  row,
  now,
  reference,
) =>
  row.state.kind === "completed" || row.state.kind === "needs_owner_choice"
    ? refundAnswerFrom(row, reference)
    : await moveRefundToOwner(
        row,
        "provider_conflict",
        now,
        reference,
        row.refunded,
      );

export const completeRefundFromEvidence: AnswerRefund = async (
  row,
  now,
  reference,
) =>
  await refundAfterTransition(
    await completeRefundAuthority(row, row.captured, now, "provider"),
    row,
    reference,
  );

export const observePendingRefund = async (
  row: RefundAuthorityRow,
  charge: ChargeMoney,
  now: number,
  reference: TaggedPaymentReference,
): Promise<ProviderRefundResult> => {
  if (
    row.state.kind === "completed" ||
    row.state.kind === "needs_owner_choice"
  ) {
    return refundAnswerFrom(row, reference);
  }
  const next = now + REFUND_OBSERVATION_DELAY_MS;
  return await refundAfterTransition(
    await transitionRefundAuthority(
      row,
      now,
      returnedRefundMoney(charge),
      (state) =>
        markRefundObservationDue(
          state.kind === "ready" ? armRefundSend(state, now, next) : state,
          now,
          next,
        ),
    ),
    row,
    reference,
  );
};
