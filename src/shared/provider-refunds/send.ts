/** Arm, authorize, send, and durably interpret one exact refund generation. */

/* jscpd:ignore-start -- imports */
import type { RefundAuthorityRow } from "#db/provider-refund-authority.ts";
import { transitionRefundAuthority } from "#db/provider-refund-authority-change.ts";
import { sameMoney } from "#payment/money.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundObservationDue,
  rearmKeyedRefund,
  returnRefundToReady,
} from "#payment/refund-authority.ts";
import type { RefundAuthorityState } from "#payment/refund-authority-state.ts";
import {
  authorizeDurableRefundSend,
  isKeylessProvider,
} from "#payment/refund-provider-authorization.ts";
import { refundRequestIdentityIndex } from "#payment/refund-request-identity.ts";
import { type ChargeMoney, returnedRefundMoney } from "#payment/resources.ts";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";
import { REFUND_RESULT_DATABASE_RESERVE } from "#shared/provider-refunds/budget.ts";
import type {
  ProviderRefundResult,
  ProviderRefundStep,
  ProviderRefundWork,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
import { withSubrequestReserve } from "#shared/subrequest-budget.ts";
import {
  completeRefundFromEvidence,
  moveRefundToOwner,
  ownerReasonWhenDue,
  REFUND_OBSERVATION_DELAY_MS,
  refundAfterTransition,
  refundAnswerFrom,
  requireCurrentRefund,
} from "./state.ts";
import { withRefundWorkFacts } from "./work.ts";

/* jscpd:ignore-end */

const authorizeSend = async (
  row: RefundAuthorityRow,
  reference: TaggedPaymentReference,
  charge: ChargeMoney,
) => {
  const request = row.state.request;
  const identityIndex = await refundRequestIdentityIndex(
    reference,
    request.generation,
  );
  if (request.identityIndex !== identityIndex) {
    throw new Error("Refund generation identity does not match its charge");
  }
  const refund = { charge, paymentReference: reference.reference };
  // The stored generation's capability must agree with what the registry
  // declares for the tagged provider — a mismatch means the record and the
  // declaration disagree about how this provider refunds.
  if (isKeylessProvider(reference.provider)) {
    if (request.capability !== "keyless") {
      throw new Error(
        "A keyed refund generation cannot name a keyless provider",
      );
    }
    return authorizeDurableRefundSend(refund, {
      capability: "keyless",
      generation: request.generation,
      identityIndex,
      provider: reference.provider,
    });
  }
  if (request.capability !== "keyed") {
    throw new Error("A keyless refund generation cannot name a keyed provider");
  }
  return authorizeDurableRefundSend(refund, {
    capability: "keyed",
    generation: request.generation,
    idempotencyKey: await refundIdempotencyKey(
      reference.provider,
      reference.reference,
      request.generation,
    ),
    identityIndex,
    provider: reference.provider,
  });
};

const persistAttempt = async (
  row: RefundAuthorityRow,
  reference: TaggedPaymentReference,
  charge: ChargeMoney,
  attempt: Awaited<ReturnType<RefundEngineProvider["refundCharge"]>>,
  now: number,
): Promise<ProviderRefundResult> => {
  if (attempt.kind === "completed") {
    if (!sameMoney(attempt.amount, charge.captured)) {
      throw new Error("Provider completed a refund for different money");
    }
    return await completeRefundFromEvidence(row, now, reference);
  }
  if (attempt.kind === "rejected") {
    return await moveRefundToOwner(
      row,
      "provider_rejected",
      now,
      reference,
      returnedRefundMoney(charge),
    );
  }
  const next = now + REFUND_OBSERVATION_DELAY_MS;
  const changed = await transitionRefundAuthority(
    row,
    now,
    returnedRefundMoney(charge),
    (state) =>
      attempt.kind === "not_sent"
        ? returnRefundToReady(state, state.evidenceRevision + 1, now, now)
        : markRefundObservationDue(state, now, next),
  );
  return await refundAfterTransition(changed, row, reference);
};

const sendArmed = async ({
  charge,
  now,
  provider,
  row,
  target,
}: ProviderRefundWork): Promise<ProviderRefundResult> => {
  const authorized = await authorizeSend(row, target.reference, charge);
  const attempt = await withSubrequestReserve(
    REFUND_RESULT_DATABASE_RESERVE,
    () => provider.refundCharge(authorized),
  );
  return await persistAttempt(row, target.reference, charge, attempt, now);
};

const sendAfterTransition = async (
  changed: RefundAuthorityRow | null,
  work: ProviderRefundWork,
): Promise<ProviderRefundResult> => {
  if (changed !== null) return await sendArmed({ ...work, row: changed });
  if (work.target.authority !== undefined) {
    return { kind: "changed", reference: work.target.reference };
  }
  return refundAnswerFrom(
    await requireCurrentRefund(work.row),
    work.target.reference,
  );
};

type RefundStateChange = (state: RefundAuthorityState) => RefundAuthorityState;

const transitionBeforeProviderCall = (
  row: RefundAuthorityRow,
  charge: ChargeMoney,
  now: number,
  change: RefundStateChange,
): Promise<RefundAuthorityRow | null> =>
  withSubrequestReserve(REFUND_RESULT_DATABASE_RESERVE, () =>
    transitionRefundAuthority(row, now, returnedRefundMoney(charge), change),
  );

export const armReadyRefund: ProviderRefundStep = async (work) => {
  const { charge, now, row } = work;
  const armed = await transitionBeforeProviderCall(row, charge, now, (state) =>
    armRefundSend(state, now, now + REFUND_OBSERVATION_DELAY_MS),
  );
  return await sendAfterTransition(armed, work);
};

export const continueActiveRefund: ProviderRefundStep = withRefundWorkFacts(
  async ({ charge, now, row, target }, work) => {
    if (row.state.kind !== "send_armed" && row.state.kind !== "observing") {
      return refundAnswerFrom(row, target.reference);
    }
    const reason = ownerReasonWhenDue(row.state, now);
    if (reason !== null) {
      return await moveRefundToOwner(
        row,
        reason,
        now,
        target.reference,
        row.refunded,
      );
    }
    if (now < row.state.nextActionAt) {
      return refundAnswerFrom(row, target.reference);
    }
    if (target.mode === "observe_only") {
      return refundAnswerFrom(row, target.reference);
    }
    const requestIndex = await refundRequestIdentityIndex(
      target.reference,
      row.state.request.generation,
    );
    const rearmed = await transitionBeforeProviderCall(
      row,
      charge,
      now,
      (state) =>
        rearmKeyedRefund(
          state,
          requestIndex,
          now,
          now + REFUND_OBSERVATION_DELAY_MS,
        ),
    );
    return await sendAfterTransition(rearmed, work);
  },
);
