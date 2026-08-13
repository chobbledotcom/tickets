import { sum } from "#fp";
import { DATABASE_MAX_ATTEMPTS } from "#shared/db/client.ts";
import {
  paymentReferencesByIndex,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { orderedCredentialedPaymentProviderTypes } from "#shared/existing-payment-provider.ts";
import { REFUND_NETWORK_RETRIES } from "#shared/payment/refund-network.ts";
import { REFUND_LEDGER_BATCH_DATABASE_CALLS } from "#shared/refund-ledger/record.ts";
import {
  REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS,
  REFUND_KNOWN_AUTHORITY_DATABASE_CALLS,
  REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS,
} from "#shared/provider-refunds/budget.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";
import type { PaymentProviderType } from "#shared/types.ts";

export type RefundBudgetAudience = "bulk" | "single";

export type RefundReadinessAction = "refund" | "refresh";

export const REFUND_BUDGET_MESSAGES = {
  bulk:
    "This run has too many payments to refund at once. Refund fewer attendees at a time.",
  single:
    "This attendee has too many payments to refund in one go. Refund them from the provider dashboard.",
} satisfies Record<RefundBudgetAudience, string>;

export const REFRESH_BUDGET_MESSAGE =
  "This attendee has too many payments to refresh safely in one request. No provider was contacted, and automatic refresh is unavailable for this payment set.";

type ProviderCallPlan = {
  readonly judgmentReads: number;
  readonly networkAttempts: number;
  readonly recoveryReads: number;
  readonly sends: number;
};

/** The production adapter calls that one still-live reference can make. */
const PROVIDER_CALL_PLANS = {
  square: {
    judgmentReads: 1,
    networkAttempts: REFUND_NETWORK_RETRIES.square + 1,
    recoveryReads: 1,
    sends: 1,
  },
  stripe: {
    judgmentReads: 1,
    networkAttempts: REFUND_NETWORK_RETRIES.stripe + 1,
    recoveryReads: 1,
    sends: 1,
  },
  sumup: {
    judgmentReads: 1,
    networkAttempts: REFUND_NETWORK_RETRIES.sumup + 1,
    recoveryReads: 1,
    sends: 1,
  },
} satisfies Record<PaymentProviderType, ProviderCallPlan>;

export type RefundBudgetCandidate = {
  readonly references: readonly RefundPaymentReference[];
};

const physicalCalls = (
  provider: PaymentProviderType,
  logicalCalls: (plan: ProviderCallPlan) => number,
): number => {
  const plan = PROVIDER_CALL_PLANS[provider];
  return logicalCalls(plan) * plan.networkAttempts;
};

type ProviderCallStage = "complete" | "judgment" | "send";

export type RefundReadinessBudgetCheckpoint =
  | "before_claim"
  | "inside_claim"
  | "before_provider_read";

/** Refresh only observes provider facts. Refund additionally prices the one
 * send and bounded recovery read that its readiness can lead to. */
const READINESS_PROVIDER_CALL_STAGES = {
  refresh: {
    before_claim: "judgment",
    before_provider_read: "judgment",
    inside_claim: "judgment",
  },
  refund: {
    before_claim: "complete",
    before_provider_read: "judgment",
    inside_claim: "judgment",
  },
} as const satisfies Record<
  RefundReadinessAction,
  Record<RefundReadinessBudgetCheckpoint, ProviderCallStage>
>;

const logicalCallsAt = (
  stage: ProviderCallStage,
): (plan: ProviderCallPlan) => number => {
  const calls = {
    complete: ({ judgmentReads, recoveryReads, sends }: ProviderCallPlan) =>
      judgmentReads + recoveryReads + sends,
    judgment: ({ judgmentReads }: ProviderCallPlan) => judgmentReads,
    send: ({ recoveryReads, sends }: ProviderCallPlan) => recoveryReads + sends,
  } satisfies Record<ProviderCallStage, (plan: ProviderCallPlan) => number>;
  return calls[stage];
};

const taggedReferenceCalls = (
  provider: PaymentProviderType,
  configured: ReadonlySet<PaymentProviderType>,
  stage: ProviderCallStage,
): number =>
  configured.has(provider) ? physicalCalls(provider, logicalCallsAt(stage)) : 0;

type ReadinessProviderCalls = {
  readonly providers: readonly PaymentProviderType[];
  readonly stage: Extract<ProviderCallStage, "complete" | "judgment">;
};

/** Discovery reads every configured provider, then only the matching one can
 * reach the send stage. */
const untaggedReferenceCalls = ({
  providers,
  stage,
}: ReadinessProviderCalls): number =>
  sum(
    providers.map((provider) =>
      physicalCalls(provider, ({ judgmentReads }) => judgmentReads)
    ),
  ) +
  (stage === "judgment" ? 0 : Math.max(
    0,
    ...providers.map((provider) =>
      physicalCalls(provider, logicalCallsAt("send"))
    ),
  ));

const referenceCalls = (
  calls: ReadinessProviderCalls,
): (reference: RefundPaymentReference) => number => {
  const { providers, stage } = calls;
  const configured = new Set(providers);
  return (reference) =>
    reference.kind === "tagged"
      ? taggedReferenceCalls(reference.provider, configured, stage)
      : untaggedReferenceCalls(calls);
};

const refundReferences = (
  candidates: readonly RefundBudgetCandidate[],
): RefundPaymentReference[] => [
  ...paymentReferencesByIndex(candidates).values(),
];

const activeReferences = (
  references: readonly RefundPaymentReference[],
  returned: ReadonlySet<string>,
): RefundPaymentReference[] =>
  references.filter(
    (reference) =>
      reference.refundState !== "completed" && !returned.has(reference.index),
  );

type DatabaseCallPlan = {
  readonly fixed: number;
  readonly pricesAuthority: boolean;
  readonly whenRecordingReturns: number;
};

const CLAIM_DATABASE_CALLS = 6;
// Admission runs before the claim batch and transaction commit.
const CLAIM_DATABASE_CALLS_AFTER_ADMISSION = 2;
const SETTLEMENT_DATABASE_CALLS = DATABASE_MAX_ATTEMPTS * 2;
const PROVIDER_BINDING_DATABASE_CALLS = 4;
const REFRESH_RECORDING_DATABASE_CALLS = REFUND_LEDGER_BATCH_DATABASE_CALLS;
const RETURNED_PAYMENT_DATABASE_CALLS = REFUND_LEDGER_BATCH_DATABASE_CALLS;

/**
 * Each checkpoint prices work through its next safe refusal. Readiness prices
 * provider judgment and durable authority; the later dispatch gate prices send
 * and recovery transport before authority work starts. Settlement has its own
 * structural reserve.
 */
const DATABASE_CALL_PLANS = {
  before_claim: {
    fixed: CLAIM_DATABASE_CALLS +
      PROVIDER_BINDING_DATABASE_CALLS,
    pricesAuthority: true,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
  before_provider_read: {
    fixed: PROVIDER_BINDING_DATABASE_CALLS,
    pricesAuthority: true,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
  inside_claim: {
    fixed: CLAIM_DATABASE_CALLS_AFTER_ADMISSION +
      PROVIDER_BINDING_DATABASE_CALLS,
    pricesAuthority: true,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
} satisfies Record<RefundReadinessBudgetCheckpoint, DatabaseCallPlan>;

const AUTHORITY_REQUEST_DATABASE_PLAN = {
  fixed: 0,
  pricesAuthority: true,
  whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
} satisfies DatabaseCallPlan;

const refreshAdmissionDatabasePlan = (
  beforeAdmissionCalls: number,
): DatabaseCallPlan => ({
  fixed: beforeAdmissionCalls +
    PROVIDER_BINDING_DATABASE_CALLS +
    REFRESH_RECORDING_DATABASE_CALLS,
  pricesAuthority: true,
  whenRecordingReturns: 0,
});

const READINESS_DATABASE_CALL_PLANS = {
  refresh: {
    before_claim: refreshAdmissionDatabasePlan(CLAIM_DATABASE_CALLS),
    before_provider_read: {
      fixed: PROVIDER_BINDING_DATABASE_CALLS +
        REFRESH_RECORDING_DATABASE_CALLS,
      pricesAuthority: true,
      whenRecordingReturns: 0,
    },
    inside_claim: refreshAdmissionDatabasePlan(
      CLAIM_DATABASE_CALLS_AFTER_ADMISSION,
    ),
  },
  refund: {
    before_claim: DATABASE_CALL_PLANS.before_claim,
    before_provider_read: DATABASE_CALL_PLANS.before_provider_read,
    inside_claim: DATABASE_CALL_PLANS.inside_claim,
  },
} satisfies Record<
  RefundReadinessAction,
  Record<RefundReadinessBudgetCheckpoint, DatabaseCallPlan>
>;

const databaseCallsAt = (
  plan: DatabaseCallPlan,
  authorityCalls: number,
): number =>
  // A non-empty refund plan may discover returned money, so every safe gate
  // reserves the full recording tail.
  plan.fixed + (plan.pricesAuthority ? authorityCalls : 0) +
  plan.whenRecordingReturns;

const zeroSubrequests = (): SubrequestCounts => ({
  database: 0,
  external: 0,
  total: 0,
});

const withDatabaseCalls = (
  database: number,
  external: number,
): SubrequestCounts => ({ database, external, total: database + external });

const subrequestCostFor = (
  plan: DatabaseCallPlan,
  authorityCalls: number,
  external: number,
): SubrequestCounts =>
  withDatabaseCalls(databaseCallsAt(plan, authorityCalls), external);

/** Every unresolved charge owns the complete durable path its action can use. */
const activeAuthorityDatabaseCalls = (
  action: RefundReadinessAction,
  count: number,
): number =>
  count *
  (action === "refund"
    ? REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS
    : REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS);

const referenceSetSubrequestCost = (
  action: RefundReadinessAction,
  references: readonly RefundPaymentReference[],
  active: readonly RefundPaymentReference[],
  checkpoint: RefundReadinessBudgetCheckpoint,
  providers: readonly PaymentProviderType[],
): SubrequestCounts => {
  const stage = READINESS_PROVIDER_CALL_STAGES[action][checkpoint];
  const external = sum(active.map(referenceCalls({ providers, stage })));
  const authorityCalls = activeAuthorityDatabaseCalls(action, active.length) +
    (references.length - active.length) *
      REFUND_KNOWN_AUTHORITY_DATABASE_CALLS;
  return subrequestCostFor(
    READINESS_DATABASE_CALL_PLANS[action][checkpoint],
    authorityCalls,
    external,
  );
};

/** Physical worst-case provider calls plus the DB work before the next safe
 * refusal. The claim wrapper withholds settlement separately, so these plans
 * never count that same reserve twice. */
export const refundReadinessSubrequestCost = (
  action: RefundReadinessAction,
  candidates: readonly RefundBudgetCandidate[],
  returned: ReadonlySet<string>,
  checkpoint: RefundReadinessBudgetCheckpoint,
  providers?: readonly PaymentProviderType[],
): SubrequestCounts => {
  if (candidates.length === 0) return zeroSubrequests();
  const configured = providers === undefined
    ? orderedCredentialedPaymentProviderTypes()
    : providers;
  const references = refundReferences(candidates);
  const active = activeReferences(references, returned);
  return referenceSetSubrequestCost(
    action,
    references,
    active,
    checkpoint,
    configured,
  );
};

export type RefundSendBudgetReference = {
  readonly index: string;
  readonly provider: PaymentProviderType;
};

export type PreparedRefundBudget = {
  readonly activeAuthorityCount: number;
  readonly mayRecordReturns: boolean;
  readonly returnedAuthorityCount: number;
  readonly sendReferences: readonly RefundSendBudgetReference[];
};

/** The late gates use the exact provider-tagged plans that preparation proved. */
export const refundPreparedSubrequestCost = (
  prepared: PreparedRefundBudget,
): SubrequestCounts => {
  const {
    activeAuthorityCount,
    mayRecordReturns,
    returnedAuthorityCount,
    sendReferences,
  } = prepared;
  if (
    activeAuthorityCount === 0 && returnedAuthorityCount === 0 &&
    !mayRecordReturns
  ) {
    return zeroSubrequests();
  }
  const external = sum(
    sendReferences.map(({ provider }) =>
      physicalCalls(provider, logicalCallsAt("send"))
    ),
  );
  return subrequestCostFor(
    AUTHORITY_REQUEST_DATABASE_PLAN,
    activeAuthorityDatabaseCalls("refund", activeAuthorityCount) +
      returnedAuthorityCount * REFUND_KNOWN_AUTHORITY_DATABASE_CALLS,
    external,
  );
};

export const subrequestCostFits = (
  cost: SubrequestCounts,
  remaining: SubrequestCounts,
): boolean =>
  cost.database <= remaining.database &&
  cost.external <= remaining.external &&
  cost.total <= remaining.total;

/** Settlement gets two DB operations, each protected through every retry. */
export const REFUND_SETTLEMENT_SUBREQUEST_RESERVE: SubrequestCounts = {
  database: SETTLEMENT_DATABASE_CALLS,
  external: 0,
  total: SETTLEMENT_DATABASE_CALLS,
};

/** Money known to be back always keeps enough room for its fixed ledger post. */
export const REFUND_LEDGER_SUBREQUEST_RESERVE: SubrequestCounts = {
  database: RETURNED_PAYMENT_DATABASE_CALLS,
  external: 0,
  total: RETURNED_PAYMENT_DATABASE_CALLS,
};
