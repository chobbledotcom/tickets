/** The one durable path allowed to ask a payment provider for a refund. */

/* jscpd:ignore-start -- imports */
import type { RefundAuthorityRow } from "#shared/db/provider-refund-authority.ts";
import { markRefundAuthorityRecorded } from "#shared/db/provider-refund-authority-change.ts";
import { nowMs } from "#shared/now.ts";
import type {
  ObservedRefundAdmission,
  WithheldRefund,
} from "#shared/payment/admit-refund.ts";
import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import { type Money, sameMoney } from "#shared/payment/money.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority-state.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { loadPaymentProvider } from "#shared/payments.ts";
import {
  armReadyRefund,
  continueActiveRefund,
} from "#shared/provider-refunds/send.ts";
import {
  answerProviderConflict,
  completeRefundFromEvidence,
  observePendingRefund,
  readRefundEvidence,
  refundAnswerFrom,
  requireCurrentRefund,
  requireMatchingRefundProvider,
} from "#shared/provider-refunds/state.ts";
import {
  answerKnownRefund,
  answerUnreadableRefund,
  createTargetAuthority,
  loadRefundTarget,
  prepareTargetAuthority,
} from "#shared/provider-refunds/target.ts";
import type { RefundWorkFacts } from "#shared/provider-refunds/work.ts";
import { withRefundWorkFacts } from "#shared/provider-refunds/work.ts";
/* jscpd:ignore-end */

export type ProviderRefundEvidence =
  | { readonly kind: "read_provider" }
  | { readonly charge: ChargeMoney; readonly kind: "observed" }
  | { readonly captured: Money; readonly kind: "validated_callback" };

interface ProviderRefundTargetFacts {
  readonly reference: TaggedPaymentReference;
}

interface CallbackRefundTarget extends ProviderRefundTargetFacts {
  readonly authority?: undefined;
  readonly callbackSessionId: string;
  readonly evidence:
    | Extract<ProviderRefundEvidence, { readonly kind: "read_provider" }>
    | Extract<ProviderRefundEvidence, { readonly kind: "validated_callback" }>;
  readonly mode: "send";
}

interface DirectRefundTarget extends ProviderRefundTargetFacts {
  readonly authority?: undefined;
  readonly callbackSessionId?: undefined;
  readonly evidence: Exclude<
    ProviderRefundEvidence,
    { readonly kind: "validated_callback" }
  >;
  readonly mode: "observe_only" | "send";
}

type RefundAuthorityRevision = Pick<RefundAuthorityRow, "id" | "revision">;

/** An owner may send only the exact authority revision they inspected. */
export interface OwnerRecoveryRefundTarget extends ProviderRefundTargetFacts {
  readonly authority: RefundAuthorityRevision;
  readonly callbackSessionId?: undefined;
  readonly evidence: Extract<
    ProviderRefundEvidence,
    { readonly kind: "read_provider" }
  >;
  readonly mode: "send";
}

/** A callback proves its charge afresh; direct callers state whether money may
 * move; owner recovery also pins the exact authority revision it showed. */
export type ProviderRefundTarget =
  | CallbackRefundTarget
  | DirectRefundTarget
  | OwnerRecoveryRefundTarget;

export type RefundEngineProvider = Pick<
  PaymentProvider,
  "readCharge" | "refundCapability" | "refundCharge" | "type"
>;

/** The facts shared by every step reconciling one durable refund. */
export interface ProviderRefundWork {
  readonly admission: ObservedRefundAdmission;
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
  readonly authority: RefundAuthorityReceipt;
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

/** The inspected authority changed before money could be sent. */
interface ChangedRefundResult extends RefundResultFacts {
  readonly kind: "changed";
}

/** A read-only probe proved that no refund has started. With no existing
 * authority there is no durable work to invent. */
interface UnchangedRefundResult extends RefundResultFacts {
  readonly kind: "unchanged";
}

interface OwnerRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt;
  readonly kind: "needs_owner_choice";
  readonly reason: Extract<
    RefundAuthorityState,
    { kind: "needs_owner_choice" }
  >["reason"];
}

interface ProviderCheckRefundResult extends RefundResultFacts {
  readonly authority: RefundAuthorityReceipt;
  readonly kind: "needs_provider_check";
  readonly reason: "provider_conflict";
}

interface WithheldRefundResult extends RefundResultFacts {
  readonly admission: Extract<WithheldRefund, { kind: "read_failed" }>;
  readonly kind: "withheld";
}

export type ProviderRefundResult =
  | ChangedRefundResult
  | OwnerRefundResult
  | PendingRefundResult
  | ProviderCheckRefundResult
  | ReadyRefundResult
  | ReturnedRefundResult
  | UnchangedRefundResult
  | WithheldRefundResult;

export type ProviderRefundStep = (
  work: ProviderRefundWork,
) => Promise<ProviderRefundResult>;

export interface ProviderRefundDependencies {
  readonly loadProvider: (
    reference: TaggedPaymentReference,
  ) => Promise<RefundEngineProvider>;
  readonly now: () => number;
}

/** Load only the adapter named by a durable provider-qualified identity. */
export const loadRefundProvider = async (
  reference: TaggedPaymentReference,
): Promise<RefundEngineProvider> => {
  const provider = await loadPaymentProvider(reference.provider);
  requireMatchingRefundProvider(provider, reference);
  return provider;
};

const DEFAULT_DEPENDENCIES: ProviderRefundDependencies = {
  loadProvider: loadRefundProvider,
  now: nowMs,
};

const providerFactsConflict = ({
  admission,
  charge,
  row,
  target,
}: RefundWorkFacts): boolean =>
  !sameMoney(row.captured, charge.captured) ||
  (target.evidence.kind === "validated_callback" &&
    !sameMoney(target.evidence.captured, charge.captured)) ||
  (row.state.kind === "needs_owner_choice" &&
    row.state.reason === "provider_conflict") ||
  row.state.kind === "needs_provider_check" ||
  admission.kind === "refused";

const reconcileRefund = async (
  facts: RefundWorkFacts,
  work: ProviderRefundWork,
): Promise<ProviderRefundResult> => {
  const { admission, charge, now, row, target } = facts;
  if (providerFactsConflict(facts)) {
    return await answerProviderConflict(charge)(row, now, target.reference);
  }
  if (admission.kind === "already_returned") {
    return await completeRefundFromEvidence(row, now, target.reference);
  }
  if (admission.kind === "in_flight") {
    return await observePendingRefund(charge)(row, now, target.reference);
  }
  if (row.state.kind === "ready") {
    return target.mode === "observe_only"
      ? refundAnswerFrom(row, target.reference)
      : await armReadyRefund(work);
  }
  return await continueActiveRefund(work);
};

const reconcile = withRefundWorkFacts(reconcileRefund);

const requestOne = async (
  target: ProviderRefundTarget,
  dependencies: ProviderRefundDependencies,
): Promise<ProviderRefundResult> => {
  const loaded = await loadRefundTarget(target);
  if (loaded.kind === "changed") {
    return { kind: "changed", reference: target.reference };
  }
  const known = answerKnownRefund(target, loaded.existing);
  if (known !== null) return known;
  const provider = await dependencies.loadProvider(target.reference);
  requireMatchingRefundProvider(provider, target.reference);
  const now = dependencies.now();
  const prepared = await prepareTargetAuthority(target, loaded, now);
  const read = await readRefundEvidence(target, provider);
  if (read.status !== "found") {
    return await answerUnreadableRefund(target, prepared, read, now);
  }
  const admission = admitObservedRefund(
    target.reference.reference,
    read.resource,
  );
  if (
    prepared === null &&
    target.mode === "observe_only" &&
    admission.kind === "send"
  ) {
    return { kind: "unchanged", reference: target.reference };
  }
  const row =
    prepared === null
      ? await createTargetAuthority(target, loaded, read.resource.captured, now)
      : prepared;
  return await reconcile({
    admission,
    charge: read.resource,
    now,
    provider,
    row,
    target,
  });
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
      const current = await requireCurrentRefund(authority);
      if (
        current.state.kind !== "completed" ||
        current.state.local.kind !== "recorded"
      ) {
        throw new Error("Refund local-recording authority changed");
      }
    }),
  );
};
