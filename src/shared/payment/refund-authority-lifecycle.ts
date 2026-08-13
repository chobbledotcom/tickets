/** The declared exit and destructive-write policy for every refund state. */

import type {
  RefundAuthorityState,
  RefundAuthorityStateName,
} from "#shared/payment/refund-authority.ts";
import type { RowMove } from "#shared/payment/admit-move.ts";

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

const always = (): boolean => true;
const never = (): boolean => false;
const unfinishedStops = { delete: always, merge: always };
const unfinished = {
  clearedBy: "requestProviderRefund",
  operatorRoute: "/admin/privacy/refunds/:id",
  refusal:
    "A provider refund for this payment is still in progress. Open Refund recovery and finish it, then try again.",
  prunable: never,
  requiresChoice: false,
  saidFirst: 2,
  storedWork: "all",
  stops: unfinishedStops,
} satisfies LifecycleRuleWithoutState;
const completedIsRecorded = (state: RefundAuthorityState): boolean =>
  state.kind === "completed" && state.local.kind === "recorded";

/** Every durable state declares how it ends and what it blocks. */
const REFUND_LIFECYCLE = {
  completed: {
    clearedBy: "markRefundAuthorityRecorded",
    operatorRoute: "/admin/privacy/refunds/:id",
    refusal:
      "The provider returned this money, but the local accounts do not show it. Record it in Refund recovery, then try again.",
    prunable: completedIsRecorded,
    requiresChoice: false,
    saidFirst: 0,
    state: "completed",
    storedWork: "local_due",
    stops: {
      delete: (state) => !completedIsRecorded(state),
      merge: (state) => !completedIsRecorded(state),
    },
  },
  needs_owner_choice: {
    clearedBy: "resolveProviderRefundCase",
    operatorRoute: "/admin/privacy/refunds/:id",
    refusal:
      "The owner still has to decide what happened to a provider refund. Resolve it in Refund recovery, then try again.",
    prunable: never,
    requiresChoice: true,
    saidFirst: 1,
    state: "needs_owner_choice",
    storedWork: "all",
    stops: unfinishedStops,
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
    Object.values(REFUND_LIFECYCLE).map((rule) =>
      rule.storedWork === "all"
        ? `${prefix}refund_state_name = '${rule.state}'`
        : `(${prefix}refund_state_name = '${rule.state}' AND ${prefix}refund_local_state = 'due')`
    ).join(" OR ")
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
