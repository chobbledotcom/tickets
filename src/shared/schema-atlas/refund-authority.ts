/** The refund authority machine, derived by running the real constructors.
 *
 * Every state below is built with the exported transition functions from
 * `refund-authority.ts` and `refund-authority-choice.ts`; every edge exists
 * because calling the named transition from that state succeeds — a transition
 * that throws is not offered. Two representative requests (keyed and keyless)
 * stand behind the capability-bearing states so edges that only one provider
 * kind allows (a keyed replay, a keyless "may have been sent") still appear. */

import type { Money } from "#shared/payment/money.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  readyRefund,
  rearmKeyedRefund,
  returnRefundToReady,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
  mayReplaceRefundWithFreshEvidence,
  type RefundOwnerChoice,
  resolveRefundOwnerChoice,
} from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import type {
  RefundAuthorityState,
  RefundRequestGeneration,
} from "#shared/payment/refund-authority-state.ts";
import type { RefundConflictDecision } from "#shared/payment/refund-conflict-decision.ts";
import {
  type AtlasEdge,
  type AtlasMachine,
  type AtlasState,
  type AtlasTrigger,
  atlasState,
  edgesFromTriggers,
} from "#shared/schema-atlas/types.ts";

const NOW = 1_750_000_000_000;
const NEXT = NOW + 60_000;

/** One keyed request generation; `replayUntil` is what makes the
 * expired-window exit reachable or not. */
const keyedRequest = (
  replayUntil: number,
): Extract<RefundRequestGeneration, { capability: "keyed" }> => ({
  capability: "keyed",
  generation: 1,
  identityIndex: "atlas-refund-request",
  replayUntil,
});
const KEYED = keyedRequest(NOW + 3_600_000);
const KEYLESS: RefundRequestGeneration = {
  capability: "keyless",
  generation: 1,
  identityIndex: "atlas-refund-request",
};
/** A keyed request whose safe replay window has already closed — an armed
 * send from before the deadline, so the expired-window exit is reachable. */
const EXPIRED_KEYED = keyedRequest(NOW - 1);

/** Provider evidence shapes the conflict transitions accept. These are
 * fixed display fixtures: exact valid money, never parsed. */
const CAPTURED_MONEY: Money = { amount: 2_500, currency: "GBP" };
const PART_MONEY: Money = { amount: 500, currency: "GBP" };
const NOTHING_MONEY: Money = { amount: 0, currency: "GBP" };
const RETURNED_EVIDENCE: RefundConflictDecision = {
  captured: CAPTURED_MONEY,
  kind: "returned",
  refunded: PART_MONEY,
};
const NOT_SENT_EVIDENCE: RefundConflictDecision = {
  captured: CAPTURED_MONEY,
  kind: "not_sent",
  refunded: NOTHING_MONEY,
};
const WAIT_EVIDENCE: RefundConflictDecision = {
  captured: CAPTURED_MONEY,
  kind: "wait",
  refunded: PART_MONEY,
};

const readyStates = [KEYED, KEYLESS].map((request) =>
  readyRefund({ evidenceRevision: 1, nextActionAt: NEXT, now: NOW, request }),
);
const armedPastWindow = armRefundSend(
  readyRefund({
    evidenceRevision: 1,
    nextActionAt: NEXT,
    now: NOW - 7_200_000,
    request: EXPIRED_KEYED,
  }),
  NOW - 3_600_000,
  NEXT,
);
const armedStates = [
  ...readyStates.map((ready) => armRefundSend(ready, NOW, NEXT)),
  armedPastWindow,
];
const armedKeyed = armedStates[0]!;
const armedKeyless = armedStates[1]!;
const observingStates = armedStates.map((armed) =>
  markRefundObservationDue(armed, NOW, NEXT),
);
const ordinaryChoiceStates = [
  // possibly_sent is the keyless ambiguity; provider_rejected reaches the same
  // open decision for a keyed request.
  markRefundOwnerChoiceNeeded(armedKeyless, NOW, "possibly_sent"),
  markRefundOwnerChoiceNeeded(armedKeyed, NOW, "provider_rejected"),
];
const conflictChoiceStates = (evidence: RefundConflictDecision) =>
  armedStates.map((armed) => markRefundProviderConflict(armed, NOW, evidence));
const completedStates = armedStates.map((armed) =>
  markRefundCompleted(armed, NOW, "provider"),
);
const recordedStates = completedStates.map((completed) =>
  markRefundLocalRecorded(completed, NOW),
);

/** The not-sent owner choice, built the way the resolution route builds it. */
const notSentChoice = (
  state: Extract<RefundAuthorityState, { kind: "needs_owner_choice" }>,
): RefundOwnerChoice => {
  const common = {
    decidedAt: NEXT,
    evidenceRevision: state.evidenceRevision + 1,
    kind: "provider_confirmed_not_sent" as const,
    nextActionAt: NEXT,
    requestIndex: state.request.identityIndex,
  };
  return state.request.capability === "keyed"
    ? {
        ...common,
        capability: "keyed",
        replayUntil: EXPIRED_KEYED.replayUntil,
      }
    : { ...common, capability: "keyless" };
};

/** The node a produced state belongs to. */
const nodeIdOf = (state: RefundAuthorityState): string => {
  switch (state.kind) {
    case "ready":
      return "ready";
    case "send_armed":
      return "send_armed";
    case "observing":
      return "observing";
    case "needs_provider_check":
      return "check";
    case "completed":
      return state.local.kind === "recorded" ? "recorded" : "returned";
    case "needs_owner_choice":
      return state.decision.kind === "returned_or_not_sent"
        ? "choice_open"
        : state.decision.kind === "returned"
          ? "choice_returned"
          : "choice_not_sent";
  }
};

/** One named transition: apply it to a state, get the state it produces. */
type RefundTrigger = AtlasTrigger<RefundAuthorityState>;

/** Fresh evidence only reaches states the engine may replace — a settled
 * conflict decision is the owner's alone. */
const whenEvidenceMayReplace =
  (run: (state: RefundAuthorityState) => RefundAuthorityState) =>
  (state: RefundAuthorityState): RefundAuthorityState => {
    if (!mayReplaceRefundWithFreshEvidence(state)) {
      throw new Error("Fresh evidence cannot replace this state");
    }
    return run(state);
  };

/** The owner answers only a state that is asking. */
const whenOwnerChoice =
  (
    run: (
      state: Extract<RefundAuthorityState, { kind: "needs_owner_choice" }>,
    ) => RefundAuthorityState,
  ) =>
  (state: RefundAuthorityState): RefundAuthorityState => {
    if (state.kind !== "needs_owner_choice") {
      throw new Error("Only an owner choice can be answered");
    }
    return run(state);
  };

const TRIGGERS: readonly RefundTrigger[] = [
  {
    actor: "system",
    labelKey: "schema.refund.edge.arm",
    run: (state) => armRefundSend(state, NOW, NEXT),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.observe",
    run: (state) => markRefundObservationDue(state, NOW, NEXT),
  },
  {
    actor: "system",
    labelKey: "schema.refund.edge.replay",
    run: (state) => rearmKeyedRefund(state, KEYED.identityIndex, NOW, NEXT),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.proved_not_sent",
    run: (state) =>
      returnRefundToReady(state, state.evidenceRevision + 1, NOW, NEXT),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.provider_returned",
    run: whenEvidenceMayReplace((state) =>
      markRefundCompleted(state, NOW, "provider"),
    ),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.unreadable",
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "provider_unreadable"),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.rejected",
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "provider_rejected"),
  },
  {
    actor: "system",
    labelKey: "schema.refund.edge.expired",
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "replay_window_expired"),
  },
  {
    actor: "system",
    labelKey: "schema.refund.edge.possibly_sent",
    run: (state) => markRefundOwnerChoiceNeeded(state, NOW, "possibly_sent"),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.conflict_returned",
    run: (state) => markRefundProviderConflict(state, NOW, RETURNED_EVIDENCE),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.conflict_not_sent",
    run: (state) => markRefundProviderConflict(state, NOW, NOT_SENT_EVIDENCE),
  },
  {
    actor: "provider",
    labelKey: "schema.refund.edge.conflict_wait",
    run: (state) => markRefundProviderConflict(state, NOW, WAIT_EVIDENCE),
  },
  {
    actor: "owner",
    labelKey: "schema.refund.edge.owner_confirms_returned",
    run: whenOwnerChoice((state) =>
      resolveRefundOwnerChoice(state, {
        decidedAt: NEXT,
        kind: "provider_confirmed_returned",
      }),
    ),
  },
  {
    actor: "owner",
    labelKey: "schema.refund.edge.owner_confirms_not_sent",
    run: whenOwnerChoice((state) =>
      resolveRefundOwnerChoice(state, notSentChoice(state)),
    ),
  },
  {
    actor: "owner",
    labelKey: "schema.refund.edge.record_in_money",
    run: (state) => markRefundLocalRecorded(state, NOW),
  },
];

/** Edges out of one node: try every trigger against every representative
 * state behind it; each success is one way the record can move. A transition
 * that lands on its own node (a keyed re-arm, another observation) stays as a
 * self edge — the record did move, it moved to itself. */
const edgesOf = (states: readonly RefundAuthorityState[]): AtlasEdge[] =>
  edgesFromTriggers<RefundAuthorityState>(TRIGGERS, nodeIdOf, states);

/** What the lifecycle declaration says ends this state, and where. */
const lifecycleFacts = (state: RefundAuthorityState): AtlasState["facts"] => {
  const lifecycle = refundLifecycleFor(state);
  return [
    { labelKey: "schema.fact.cleared_by", value: lifecycle.clearedBy },
    { labelKey: "schema.fact.route", value: lifecycle.operatorRoute },
  ];
};

const node = (
  id: string,
  layout: AtlasState["layout"],
  states: readonly RefundAuthorityState[],
  start = false,
): AtlasState =>
  atlasState("schema.refund.state", id, layout, edgesOf(states), {
    facts: lifecycleFacts(states[0]!),
    ...(start ? { start: true as const } : {}),
  });

/** The whole refund machine: states from the constructors, edges from the
 * transitions succeeding. */
export const refundAuthorityAtlas = (): AtlasMachine => ({
  id: "refund",
  introKey: "schema.refund.intro",
  states: [
    node("ready", { x: 110, y: 250 }, readyStates, true),
    node("send_armed", { x: 370, y: 110 }, armedStates),
    node("observing", { x: 640, y: 110 }, observingStates),
    node("check", { x: 900, y: 250 }, conflictChoiceStates(WAIT_EVIDENCE)),
    node("choice_open", { x: 370, y: 400 }, ordinaryChoiceStates),
    node(
      "choice_not_sent",
      { x: 370, y: 540 },
      conflictChoiceStates(NOT_SENT_EVIDENCE),
    ),
    node(
      "choice_returned",
      { x: 640, y: 400 },
      conflictChoiceStates(RETURNED_EVIDENCE),
    ),
    node("returned", { x: 640, y: 540 }, completedStates),
    node("recorded", { x: 900, y: 540 }, recordedStates),
  ],
  titleKey: "schema.refund.title",
});
