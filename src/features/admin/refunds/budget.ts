/** Static subrequest admission for one complete admin refund command. */

import { partition, sum } from "#fp";
import { DATABASE_MAX_ATTEMPTS } from "#shared/db/client.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import { orderedCredentialedPaymentProviderTypes } from "#shared/existing-payment-provider.ts";
import { SQUARE_MAX_NETWORK_RETRIES } from "#shared/square/transport.ts";
import { STRIPE_MAX_NETWORK_RETRIES } from "#shared/stripe/request.ts";
import {
  BULK_REFUND_LIMIT,
  type SubrequestCounts,
} from "#shared/subrequest-budget.ts";
import { SUMUP_MAX_NETWORK_RETRIES } from "#shared/sumup/transport.ts";
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
    networkAttempts: SQUARE_MAX_NETWORK_RETRIES + 1,
    recoveryReads: 1,
    sends: 1,
  },
  stripe: {
    judgmentReads: 1,
    networkAttempts: STRIPE_MAX_NETWORK_RETRIES + 1,
    recoveryReads: 1,
    sends: 1,
  },
  sumup: {
    judgmentReads: 1,
    networkAttempts: SUMUP_MAX_NETWORK_RETRIES + 1,
    recoveryReads: 1,
    sends: 1,
  },
} satisfies Record<PaymentProviderType, ProviderCallPlan>;

export type RefundBudgetCandidate = {
  readonly attendeeId?: number;
  readonly held?: boolean;
  readonly references: readonly RefundPaymentReference[];
};

export const carriesHeldRefundRows = (
  candidate: RefundBudgetCandidate,
): boolean =>
  candidate.held === true ||
  candidate.references.some(
    ({ heldRowSessionIds }) => heldRowSessionIds.length > 0,
  );

const inheritedAttendeeIds = (
  candidates: readonly RefundBudgetCandidate[],
  inherited?: ReadonlySet<number>,
): ReadonlySet<number> =>
  inherited ??
  new Set(
    candidates.flatMap((candidate) => {
      if (!carriesHeldRefundRows(candidate)) return [];
      if (candidate.attendeeId === undefined) {
        throw new Error("A held refund candidate has no attendee id");
      }
      return [candidate.attendeeId];
    }),
  );

/** Resume loaded holds first, then take fresh attendees in their loaded order. */
export const selectRefundExecutionCandidates = <
  TCandidate extends RefundBudgetCandidate,
>(
  candidates: readonly TCandidate[],
  limit = BULK_REFUND_LIMIT,
  inherited?: ReadonlySet<number>,
): TCandidate[] => {
  const inheritedIds = inheritedAttendeeIds(candidates, inherited);
  const [held, fresh] = partition(
    (candidate: TCandidate) =>
      candidate.attendeeId !== undefined &&
      inheritedIds.has(candidate.attendeeId),
  )([...candidates]);
  return [...held, ...fresh].slice(0, limit);
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

const activeReferences = (
  candidates: readonly RefundBudgetCandidate[],
  returned: ReadonlySet<string>,
): RefundPaymentReference[] =>
  [
    ...new Map(
      candidates
        .flatMap(({ references }) => references)
        .map((reference) => [reference.index, reference] as const),
    ).values(),
  ].filter(
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
  readonly always: number;
  readonly transactionHeadroom: number;
  readonly whenSending: number;
};

/**
 * Each checkpoint owns only the database boundary that must finish before the
 * next safe refusal. A following transaction also needs one untouched rollback
 * call while it runs. Settlement and the caller tail have nested reserves.
 */
const DATABASE_CALL_PLANS = {
  before_claim: {
    always: 6 + 4,
    transactionHeadroom: 1,
    whenSending: 4,
  },
  before_dispatch_arm: {
    always: 0,
    transactionHeadroom: 1,
    whenSending: 4,
  },
  before_provider_read: {
    always: 4,
    transactionHeadroom: 1,
    whenSending: 0,
  },
  before_provider_send: {
    always: 0,
    transactionHeadroom: 0,
    whenSending: 0,
  },
  inside_claim: {
    always: 2 + 4,
    transactionHeadroom: 1,
    whenSending: 4,
  },
} satisfies Record<RefundBudgetCheckpoint, DatabaseCallPlan>;

const zeroSubrequests = (): SubrequestCounts => ({
  database: 0,
  external: 0,
  total: 0,
});

const withDatabaseCalls = (
  database: number,
  external: number,
): SubrequestCounts => ({ database, external, total: database + external });

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
  const databasePlan = DATABASE_CALL_PLANS[checkpoint];
  const references = activeReferences(candidates, returned);
  const database =
    databasePlan.always +
    databasePlan.transactionHeadroom +
    (references.length === 0 ? 0 : databasePlan.whenSending);
  const stage = PROVIDER_CALL_STAGES[checkpoint];
  const external = sum(
    references.map(referenceCalls({ providers: configured, stage })),
  );
  return withDatabaseCalls(database, external);
};

export type RefundSendBudgetReference = {
  readonly index: string;
  readonly provider: PaymentProviderType;
};

/** The late gates use the exact provider-tagged plans that preparation proved. */
export const refundPreparedSubrequestCost = (
  references: readonly RefundSendBudgetReference[],
  checkpoint: RefundDispatchBudgetCheckpoint,
): SubrequestCounts => {
  if (references.length === 0) return zeroSubrequests();
  const databasePlan = DATABASE_CALL_PLANS[checkpoint];
  const database =
    databasePlan.always +
    databasePlan.transactionHeadroom +
    databasePlan.whenSending;
  const stage = PROVIDER_CALL_STAGES[checkpoint];
  const external = sum(
    references.map(({ provider }) =>
      physicalCalls(provider, logicalCallsAt(stage)),
    ),
  );
  return withDatabaseCalls(database, external);
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
