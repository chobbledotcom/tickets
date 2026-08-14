/** The declared exit and destructive-write policy for every refund state. */

import type { RowMove } from "#shared/payment/admit-move.ts";
import type {
  NeedsProviderCheckRefundState,
  RefundAuthorityState,
  RefundAuthorityStateName,
} from "#shared/payment/refund-authority-state.ts";

type LifecycleExit =
  | {
    clearedBy: "resolveProviderRefundCase";
    requiresChoice: true;
  }
  | {
    clearedBy: "markRefundAuthorityRecorded" | "requestProviderRefund";
    requiresChoice: false;
  };

type LifecycleRecovery = LifecycleExit & {
  refusal: string;
};

type LifecycleRuleWithoutState = {
  operatorRoute: string;
  prunable: (state: RefundAuthorityState) => boolean;
  recovery: (state: RefundAuthorityState) => LifecycleRecovery;
  saidFirst: number;
  storedWork: "all" | "local_due";
  stops: Record<RowMove, (state: RefundAuthorityState) => boolean>;
};

type LifecycleRule = LifecycleRuleWithoutState & {
  state: RefundAuthorityStateName;
};

type LifecycleRules = {
  [Name in RefundAuthorityStateName]: LifecycleRule & { state: Name };
};

const always = (_state: RefundAuthorityState): boolean => true;
const never = (_state: RefundAuthorityState): boolean => false;
// A merge relocates the indexed row that reaches this charge; it does not
// destroy or reparent the charge authority itself.
const refundWorkStops = {
  delete: always,
  merge: never,
};

const REFUND_RECOVERY = {
  check_partial: {
    clearedBy: "requestProviderRefund",
    refusal:
      "The provider shows only part of this payment returned. Check it again in Refund recovery, then try again.",
    requiresChoice: false,
  },
  check_inconclusive: {
    clearedBy: "requestProviderRefund",
    refusal:
      "The provider evidence is not conclusive yet. Check it again in Refund recovery, then try again.",
    requiresChoice: false,
  },
  choose: {
    clearedBy: "resolveProviderRefundCase",
    refusal:
      "The owner still has to decide what happened to a provider refund. Resolve it in Refund recovery, then try again.",
    requiresChoice: true,
  },
  continue: {
    clearedBy: "requestProviderRefund",
    refusal:
      "A provider refund for this payment is still in progress. Open Refund recovery and finish it, then try again.",
    requiresChoice: false,
  },
  record: {
    clearedBy: "markRefundAuthorityRecorded",
    refusal:
      "The provider returned this money, but the local accounts do not show it. Record it in Refund recovery, then try again.",
    requiresChoice: false,
  },
} as const satisfies Record<string, LifecycleRecovery>;

const fixedRecovery =
  (recovery: LifecycleRecovery) =>
  (_state: RefundAuthorityState): LifecycleRecovery => recovery;

const PROVIDER_CHECK_RECOVERY = {
  returned: REFUND_RECOVERY.check_partial,
  wait: REFUND_RECOVERY.check_inconclusive,
} as const;

const providerCheckRecovery = (
  state: NeedsProviderCheckRefundState,
): LifecycleRecovery => {
  const kind = state.decision.kind;
  if (kind !== "returned" && kind !== "wait") {
    throw new Error(`Provider-check evidence cannot be ${kind}`);
  }
  return PROVIDER_CHECK_RECOVERY[kind];
};

const unfinished = {
  operatorRoute: "/admin/privacy/refunds/:id",
  prunable: never,
  recovery: fixedRecovery(REFUND_RECOVERY.continue),
  saidFirst: 3,
  stops: refundWorkStops,
  storedWork: "all",
} satisfies LifecycleRuleWithoutState;
const completedIsRecorded = (state: RefundAuthorityState): boolean =>
  state.kind === "completed" && state.local.kind === "recorded";

/** Every durable state declares how it ends and what it blocks. */
const REFUND_LIFECYCLE = {
  completed: {
    operatorRoute: "/admin/privacy/refunds/:id",
    prunable: completedIsRecorded,
    recovery: fixedRecovery(REFUND_RECOVERY.record),
    saidFirst: 0,
    state: "completed",
    stops: {
      delete: (state) => !completedIsRecorded(state),
      merge: never,
    },
    storedWork: "local_due",
  },
  needs_owner_choice: {
    operatorRoute: "/admin/privacy/refunds/:id",
    prunable: never,
    recovery: fixedRecovery(REFUND_RECOVERY.choose),
    saidFirst: 1,
    state: "needs_owner_choice",
    stops: refundWorkStops,
    storedWork: "all",
  },
  needs_provider_check: {
    operatorRoute: "/admin/privacy/refunds/:id",
    prunable: never,
    recovery: (state) => {
      if (state.kind !== "needs_provider_check") {
        throw new Error(
          "Provider-check recovery received another refund state",
        );
      }
      return providerCheckRecovery(state);
    },
    saidFirst: 2,
    state: "needs_provider_check",
    stops: refundWorkStops,
    storedWork: "all",
  },
  observing: { ...unfinished, state: "observing" },
  ready: { ...unfinished, state: "ready" },
  send_armed: { ...unfinished, state: "send_armed" },
} satisfies LifecycleRules;

type RefundAuthorityColumnPrefix = "" | "charge.";

/** The one SQL form of the same states that block destructive work. */
export const refundAuthorityWorkSql = (
  prefix: RefundAuthorityColumnPrefix,
): string =>
  `(${
    Object.values(REFUND_LIFECYCLE)
      .map((rule) =>
        rule.storedWork === "all"
          ? `${prefix}refund_state_name = '${rule.state}'`
          : `(${prefix}refund_state_name = '${rule.state}' AND ${prefix}refund_local_state = 'due')`
      )
      .join(" OR ")
  })`;

export type RefundLifecycle = {
  readonly blocks: Record<RowMove, boolean>;
  readonly clearedBy: string;
  readonly operatorRoute: string;
  readonly prunable: boolean;
  readonly refusal: string;
  readonly requiresChoice: boolean;
};

/** Evaluate the lifecycle declaration for one parsed durable state. */
export const refundLifecycleFor = (
  state: RefundAuthorityState,
): RefundLifecycle => {
  const rule = REFUND_LIFECYCLE[state.kind];
  const recovery = rule.recovery(state);
  return {
    blocks: {
      delete: rule.stops.delete(state),
      merge: rule.stops.merge(state),
    },
    clearedBy: recovery.clearedBy,
    operatorRoute: rule.operatorRoute,
    prunable: rule.prunable(state),
    refusal: recovery.refusal,
    requiresChoice: recovery.requiresChoice,
  };
};

/** Why these durable refund states stop a destructive move, or no refusal. */
export const refundMoveRefusalOrNull = (
  states: readonly RefundAuthorityState[],
  move: RowMove,
): string | null => {
  const blocking = states
    .map((state) => ({ rule: REFUND_LIFECYCLE[state.kind], state }))
    .filter(({ rule, state }) => rule.stops[move](state))
    .sort((one, other) => one.rule.saidFirst - other.rule.saidFirst)[0];
  return blocking === undefined
    ? null
    : blocking.rule.recovery(blocking.state).refusal;
};
