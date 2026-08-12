/** Static subrequest admission for one complete admin refund command. */

import { sum } from "#fp";
import { DATABASE_MAX_ATTEMPTS } from "#shared/db/client.ts";
import {
  paymentReferencesByIndex,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { orderedCredentialedPaymentProviderTypes } from "#shared/existing-payment-provider.ts";
import { REFUND_NETWORK_RETRIES } from "#shared/payment/refund-network.ts";
import { REFUND_LEDGER_BATCH_DATABASE_CALLS } from "#shared/refund-ledger/record.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";
import type { PaymentProviderType } from "#shared/types.ts";

export type RefundBudgetAudience = "bulk" | "single";

export const REFUND_BUDGET_MESSAGES = {
  bulk: "This run has too many payments to refund at once. Refund fewer attendees at a time.",
  single:
    "This attendee has too many payments to refund in one go. Refund them from the provider dashboard.",
} satisfies Record<RefundBudgetAudience, string>;

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

type ProviderCallStage = "complete" | "judgment" | "none" | "send";

const PROVIDER_CALL_STAGES = {
  before_claim: "complete",
  before_dispatch_arm: "none",
  before_provider_read: "judgment",
  before_provider_send: "send",
  inside_claim: "complete",
} as const satisfies Record<RefundBudgetCheckpoint, ProviderCallStage>;

const logicalCallsAt = (
  stage: ProviderCallStage,
): ((plan: ProviderCallPlan) => number) => {
  const calls = {
    complete: ({ judgmentReads, recoveryReads, sends }: ProviderCallPlan) =>
      judgmentReads + recoveryReads + sends,
    judgment: ({ judgmentReads }: ProviderCallPlan) => judgmentReads,
    none: (_plan: ProviderCallPlan) => 0,
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
      physicalCalls(provider, ({ judgmentReads }) => judgmentReads),
    ),
  ) +
  (stage === "judgment"
    ? 0
    : Math.max(
        0,
        ...providers.map((provider) =>
          physicalCalls(provider, logicalCallsAt("send")),
        ),
      ));

const referenceCalls = (
  calls: ReadinessProviderCalls,
): ((reference: RefundPaymentReference) => number) => {
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

export type RefundBudgetCheckpoint =
  | "before_claim"
  | "inside_claim"
  | "before_provider_read"
  | "before_dispatch_arm"
  | "before_provider_send";

export type RefundReadinessBudgetCheckpoint = Extract<
  RefundBudgetCheckpoint,
  "before_claim" | "inside_claim" | "before_provider_read"
>;

export type RefundDispatchBudgetCheckpoint = Extract<
  RefundBudgetCheckpoint,
  "before_dispatch_arm" | "before_provider_send"
>;

type DatabaseCallPlan = {
  readonly fixed: number;
  readonly whenArming: number;
  readonly whenRecordingReturns: number;
};

const CLAIM_DATABASE_CALLS = 6;
const CLAIM_DATABASE_CALLS_AFTER_ADMISSION = 2;
const PROVIDER_BINDING_DATABASE_CALLS = 4;
const DISPATCH_ARM_DATABASE_CALLS = 4;
const TRANSACTION_ROLLBACK_HEADROOM = 1;
const RETURNED_MARKER_DATABASE_CALLS = 1;
const RETURNED_PAYMENT_DATABASE_CALLS =
  RETURNED_MARKER_DATABASE_CALLS + REFUND_LEDGER_BATCH_DATABASE_CALLS;

/**
 * Each checkpoint prices only work before its next safe refusal. Arming is its
 * own transaction; recording a return is one marker write plus the fixed refund
 * ledger batch. Settlement and the caller tail have separate nested reserves.
 */
const DATABASE_CALL_PLANS = {
  before_claim: {
    fixed:
      CLAIM_DATABASE_CALLS +
      PROVIDER_BINDING_DATABASE_CALLS +
      TRANSACTION_ROLLBACK_HEADROOM,
    whenArming: DISPATCH_ARM_DATABASE_CALLS,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
  before_dispatch_arm: {
    fixed: 0,
    whenArming: DISPATCH_ARM_DATABASE_CALLS + TRANSACTION_ROLLBACK_HEADROOM,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
  before_provider_read: {
    fixed: PROVIDER_BINDING_DATABASE_CALLS + TRANSACTION_ROLLBACK_HEADROOM,
    whenArming: 0,
    whenRecordingReturns: 0,
  },
  before_provider_send: {
    fixed: 0,
    whenArming: 0,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
  inside_claim: {
    fixed:
      CLAIM_DATABASE_CALLS_AFTER_ADMISSION +
      PROVIDER_BINDING_DATABASE_CALLS +
      TRANSACTION_ROLLBACK_HEADROOM,
    whenArming: DISPATCH_ARM_DATABASE_CALLS,
    whenRecordingReturns: RETURNED_PAYMENT_DATABASE_CALLS,
  },
} satisfies Record<RefundBudgetCheckpoint, DatabaseCallPlan>;

type DatabaseCallFacts = {
  readonly mayArm: boolean;
};

const databaseCallsAt = (
  plan: DatabaseCallPlan,
  facts: DatabaseCallFacts,
): number =>
  // A non-empty refund plan may discover returned money, so every safe gate
  // reserves the full recording tail.
  plan.fixed + (facts.mayArm ? plan.whenArming : 0) + plan.whenRecordingReturns;

const zeroSubrequests = (): SubrequestCounts => ({
  database: 0,
  external: 0,
  total: 0,
});

const withDatabaseCalls = (
  database: number,
  external: number,
): SubrequestCounts => ({ database, external, total: database + external });

const subrequestCostAt = (
  checkpoint: RefundBudgetCheckpoint,
  mayArm: boolean,
  external: number,
): SubrequestCounts =>
  withDatabaseCalls(
    databaseCallsAt(DATABASE_CALL_PLANS[checkpoint], { mayArm }),
    external,
  );

/** Physical worst-case provider calls plus current nominal DB work. Cleanup
 * and route-tail retry reserves are enforced by nested allowances instead. */
export const refundSubrequestCost = (
  candidates: readonly RefundBudgetCandidate[],
  returned: ReadonlySet<string>,
  checkpoint: RefundReadinessBudgetCheckpoint,
  providers?: readonly PaymentProviderType[],
): SubrequestCounts => {
  if (candidates.length === 0) return zeroSubrequests();
  const configured = providers ?? orderedCredentialedPaymentProviderTypes();
  const references = refundReferences(candidates);
  const active = activeReferences(references, returned);
  const stage = PROVIDER_CALL_STAGES[checkpoint];
  const external = sum(
    active.map(referenceCalls({ providers: configured, stage })),
  );
  return subrequestCostAt(checkpoint, active.length > 0, external);
};

export type RefundSendBudgetReference = {
  readonly index: string;
  readonly provider: PaymentProviderType;
};

export type PreparedRefundBudget = {
  readonly mayRecordReturns: boolean;
  readonly sendReferences: readonly RefundSendBudgetReference[];
};

/** The late gates use the exact provider-tagged plans that preparation proved. */
export const refundPreparedSubrequestCost = (
  prepared: PreparedRefundBudget,
  checkpoint: RefundDispatchBudgetCheckpoint,
): SubrequestCounts => {
  const { mayRecordReturns, sendReferences } = prepared;
  if (sendReferences.length === 0 && !mayRecordReturns) {
    return zeroSubrequests();
  }
  const stage = PROVIDER_CALL_STAGES[checkpoint];
  const external = sum(
    sendReferences.map(({ provider }) =>
      physicalCalls(provider, logicalCallsAt(stage)),
    ),
  );
  return subrequestCostAt(checkpoint, sendReferences.length > 0, external);
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
  database: DATABASE_MAX_ATTEMPTS * 2,
  external: 0,
  total: DATABASE_MAX_ATTEMPTS * 2,
};

/** Every successful route writes one final owner-facing activity entry. */
export const REFUND_CALLER_SUBREQUEST_RESERVE: SubrequestCounts = {
  database: DATABASE_MAX_ATTEMPTS,
  external: 0,
  total: DATABASE_MAX_ATTEMPTS,
};
