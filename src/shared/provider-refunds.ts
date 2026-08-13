/** The one durable path allowed to ask a payment provider for a refund. */

import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
/* jscpd:ignore-start -- imports */
import type { RefundAuthorityRow } from "#shared/db/provider-refund-authority.ts";
import {
  bindRefundCallbackIfChargeExists,
  createOrLoadRefundAuthority,
  loadRefundAuthorityById,
  loadRefundAuthorityByReference,
  markRefundAuthorityRecorded,
} from "#shared/db/provider-refund-authority.ts";
import { nowMs } from "#shared/now.ts";
import type { WithheldRefund } from "#shared/payment/admit-refund.ts";
import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { loadPaymentProvider } from "#shared/payments.ts";
import {
  armReadyRefund,
  continueActiveRefund,
} from "#shared/provider-refunds/send.ts";
import {
  completeRefundFromEvidence,
  initialRefundState,
  moveRefundToOwner,
  observePendingRefund,
  ownerReasonWhenDue,
  readRefundEvidence,
  refundAnswerFrom,
  requireMatchingCharge,
  requireMatchingRefundProvider,
  returnedRefundMoney,
} from "#shared/provider-refunds/state.ts";
import type { RefundWorkFacts } from "#shared/provider-refunds/work.ts";
import { withRefundWorkFacts } from "#shared/provider-refunds/work.ts";
/* jscpd:ignore-end */

export type ProviderRefundEvidence =
  | { readonly kind: "read_provider" }
  | { readonly charge: ChargeMoney; readonly kind: "observed" }
  | { readonly kind: "returned_marker" };

interface ProviderRefundTargetFacts {
  readonly reference: TaggedPaymentReference;
}

interface CallbackRefundTarget extends ProviderRefundTargetFacts {
  readonly callbackSessionId: string;
  readonly evidence: Extract<
    ProviderRefundEvidence,
    { readonly kind: "read_provider" }
  >;
  readonly mode: "send";
}

interface DirectRefundTarget extends ProviderRefundTargetFacts {
  readonly callbackSessionId?: undefined;
  readonly evidence: ProviderRefundEvidence;
  readonly mode: "observe_only" | "send";
}

/** A callback always proves its charge afresh and explicitly asks to send.
 * Other callers must still state whether their evidence may move money. */
export type ProviderRefundTarget = CallbackRefundTarget | DirectRefundTarget;

export type RefundEngineProvider = Pick<
  PaymentProvider,
  "readCharge" | "refundCapability" | "refundCharge" | "type"
>;

/** The facts shared by every step reconciling one durable refund. */
export interface ProviderRefundWork {
  readonly charge: ChargeMoney;
  readonly now: number;
  readonly provider: RefundEngineProvider;
  readonly row: RefundAuthorityRow;
  readonly target: ProviderRefundTarget;
}

export type RefundAuthorityReceipt = Pick<
  RefundAuthorityRow,
  "id" | "referenceIndex" | "revision"
>;

interface RefundResultFacts {
  readonly reference: TaggedPaymentReference;
}

interface ReturnedRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt | null;
  readonly kind: "returned";
  readonly local: "due" | "recorded";
}

interface PendingRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt;
  readonly kind: "pending";
  readonly state: "observing" | "send_armed";
}

interface ReadyRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt;
  readonly kind: "ready";
}

interface OwnerRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt;
  readonly kind: "needs_owner_choice";
  readonly reason: Extract<
    RefundAuthorityState,
    { kind: "needs_owner_choice" }
  >["reason"];
}

interface WithheldRefundResult extends RefundResultFacts {
  readonly admission: WithheldRefund;
  readonly kind: "withheld";
}

export type ProviderRefundResult =
  | OwnerRefundResult
  | PendingRefundResult
  | ReadyRefundResult
  | ReturnedRefundResult
  | WithheldRefundResult;

export type ProviderRefundStep = (
  work: ProviderRefundWork,
) => Promise<ProviderRefundResult>;

export interface ProviderRefundDependencies {
  readonly loadProvider: (
    provider: TaggedPaymentReference["provider"],
  ) => Promise<RefundEngineProvider>;
  readonly now: () => number;
}

const DEFAULT_DEPENDENCIES: ProviderRefundDependencies = {
  loadProvider: loadPaymentProvider,
  now: nowMs,
};

const reconcileRefund = async (
  { charge, now, row, target }: RefundWorkFacts,
  work: ProviderRefundWork,
): Promise<ProviderRefundResult> => {
  requireMatchingCharge(row, charge);
  const admission = admitObservedRefund(target.reference.reference, charge);
  if (admission.kind === "already_returned") {
    return row.state.kind === "completed"
      ? refundAnswerFrom(row, target.reference)
      : await completeRefundFromEvidence(row, now, target.reference);
  }
  if (admission.kind === "in_flight") {
    return await observePendingRefund(row, charge, now, target.reference);
  }
  if (admission.kind === "refused") {
    return row.state.kind === "completed" ||
        row.state.kind === "needs_owner_choice"
      ? refundAnswerFrom(row, target.reference)
      : await moveRefundToOwner(
        row,
        "provider_conflict",
        now,
        target.reference,
        returnedRefundMoney(charge),
      );
  }
  if (target.mode === "observe_only") {
    return refundAnswerFrom(row, target.reference);
  }
  if (row.state.kind === "ready") {
    return await armReadyRefund(work);
  }
  return await continueActiveRefund(work);
};

const reconcile = withRefundWorkFacts(reconcileRefund);

interface LoadedRefundTarget {
  readonly callbackReplayIndex: string | undefined;
  readonly existing: RefundAuthorityRow | null;
}

const loadRefundTarget = async (
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
    existing: await bindRefundCallbackIfChargeExists(
      { callbackReplayIndex, referenceIndex },
    ),
  };
};

const answerKnownRefund = (
  target: ProviderRefundTarget,
  existing: RefundAuthorityRow | null,
): ProviderRefundResult | null => {
  if (target.evidence.kind === "returned_marker") {
    if (existing !== null) return refundAnswerFrom(existing, target.reference);
    return {
      authority: null,
      kind: "returned",
      local: "due",
      reference: target.reference,
    };
  }
  if (
    existing?.state.kind === "completed" ||
    existing?.state.kind === "needs_owner_choice"
  ) {
    return refundAnswerFrom(existing, target.reference);
  }
  return null;
};

const answerUnreadableRefund = async (
  target: ProviderRefundTarget,
  existing: RefundAuthorityRow | null,
  read: Exclude<
    Awaited<ReturnType<RefundEngineProvider["readCharge"]>>,
    {
      status: "found";
    }
  >,
  now: number,
): Promise<ProviderRefundResult> => {
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

const createTargetAuthority = async (
  target: ProviderRefundTarget,
  loaded: LoadedRefundTarget,
  provider: RefundEngineProvider,
  charge: ChargeMoney,
  now: number,
): Promise<RefundAuthorityRow> => {
  const created = loaded.existing === null
    ? await createOrLoadRefundAuthority({
      ...(loaded.callbackReplayIndex === undefined ? {} : {
        callbackReplayIndex: loaded.callbackReplayIndex,
      }),
      capability: provider.refundCapability,
      captured: charge.captured,
      now,
      reference: target.reference,
      state: await initialRefundState(target.reference, provider, now),
    })
    : loaded.existing;
  return created;
};

const requestOne = async (
  target: ProviderRefundTarget,
  dependencies: ProviderRefundDependencies,
): Promise<ProviderRefundResult> => {
  const loaded = await loadRefundTarget(target);
  const known = answerKnownRefund(target, loaded.existing);
  if (known !== null) return known;
  const provider = await dependencies.loadProvider(target.reference.provider);
  requireMatchingRefundProvider(provider, target.reference);
  const read = await readRefundEvidence(target, provider);
  const now = dependencies.now();
  if (read.status !== "found") {
    return await answerUnreadableRefund(target, loaded.existing, read, now);
  }
  const row = await createTargetAuthority(
    target,
    loaded,
    provider,
    read.resource,
    now,
  );
  return await reconcile({ charge: read.resource, now, provider, row, target });
};

/** Ask for one or many refunds through the same durable authority. */
export const requestProviderRefunds = (
  targets: readonly ProviderRefundTarget[],
  dependencies: ProviderRefundDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProviderRefundResult[]> =>
  Promise.all(targets.map((target) => requestOne(target, dependencies)));

/** A single refund is the one-or-many operation with an array of one. */
export const requestProviderRefund = async (
  target: ProviderRefundTarget,
  dependencies: ProviderRefundDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProviderRefundResult> =>
  (await requestProviderRefunds([target], dependencies))[0]!;

/** Retire the local-recording obligation for every successfully posted return. */
export const recordProviderRefunds = async (
  authorities: readonly RefundAuthorityReceipt[],
  at = nowMs(),
): Promise<void> => {
  await Promise.all(
    authorities.map(async (authority) => {
      const changed = await markRefundAuthorityRecorded(
        authority.id,
        authority.revision,
        at,
      );
      if (changed !== null) return;
      const current = await loadRefundAuthorityById(authority.id);
      if (
        current === null ||
        current.state.kind !== "completed" ||
        current.state.local.kind !== "recorded"
      ) {
        throw new Error("Refund local-recording authority changed");
      }
    }),
  );
};
