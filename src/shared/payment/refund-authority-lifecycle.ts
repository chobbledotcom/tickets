/** The declared exit and destructive-write policy for every refund state. */

import type { RowMove } from "#shared/payment/admit-move.ts";
import type {
  RefundAuthorityState,
  RefundAuthorityStateName,
} from "#shared/payment/refund-authority.ts";

type LifecycleExit =
  | {
      clearedBy: "resolveProviderRefundCase";
      requiresChoice: true;
    }
  | {
      clearedBy: "markRefundAuthorityRecorded" | "requestProviderRefund";
      requiresChoice: false;
    };

type LifecycleRuleWithoutState = LifecycleExit & {
  operatorRoute: string;
  refusal: string;
  prunable: (state: RefundAuthorityState) => boolean;
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
const unfinished = {
  clearedBy: "requestProviderRefund",
  operatorRoute: "/admin/privacy/refunds/:id",
  prunable: never,
  refusal:
    "A provider refund for this payment is still in progress. Open Refund recovery and finish it, then try again.",
  requiresChoice: false,
  saidFirst: 2,
  stops: refundWorkStops,
  storedWork: "all",
} satisfies LifecycleRuleWithoutState;
const completedIsRecorded = (state: RefundAuthorityState): boolean =>
  state.kind === "completed" && state.local.kind === "recorded";

/** Every durable state declares how it ends and what it blocks. */
const REFUND_LIFECYCLE = {
  completed: {
    clearedBy: "markRefundAuthorityRecorded",
    operatorRoute: "/admin/privacy/refunds/:id",
    prunable: completedIsRecorded,
    refusal:
      "The provider returned this money, but the local accounts do not show it. Record it in Refund recovery, then try again.",
    requiresChoice: false,
    saidFirst: 0,
    state: "completed",
    stops: {
      delete: (state) => !completedIsRecorded(state),
      merge: never,
    },
    storedWork: "local_due",
  },
  needs_owner_choice: {
    clearedBy: "resolveProviderRefundCase",
    operatorRoute: "/admin/privacy/refunds/:id",
    prunable: never,
    refusal:
      "The owner still has to decide what happened to a provider refund. Resolve it in Refund recovery, then try again.",
    requiresChoice: true,
    saidFirst: 1,
    state: "needs_owner_choice",
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
  `(${Object.values(REFUND_LIFECYCLE)
    .map((rule) =>
      rule.storedWork === "all"
        ? `${prefix}refund_state_name = '${rule.state}'`
        : `(${prefix}refund_state_name = '${rule.state}' AND ${prefix}refund_local_state = 'due')`,
    )
    .join(" OR ")})`;

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
  return {
    blocks: {
      delete: rule.stops.delete(state),
      merge: rule.stops.merge(state),
    },
    clearedBy: rule.clearedBy,
    operatorRoute: rule.operatorRoute,
    prunable: rule.prunable(state),
    refusal: rule.refusal,
    requiresChoice: rule.requiresChoice,
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
  return blocking?.rule.refusal ?? null;
};
