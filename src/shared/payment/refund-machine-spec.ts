/** The refund machine as one executable table: every stored shape, every
 * transition, and the exact move each pair must make.
 *
 * The atlas on `/admin/schema` DESCRIBES the machine — it draws whatever the
 * real transitions do, so it can never fail. This module is the other half:
 * it DECLARES what each transition must do, and the mirror test executes
 * every (node × event × representative) cell against the real production
 * functions. A cell missing from {@link EXPECTED_MOVES} is not skipped — it
 * is the declaration that the transition must refuse (throw), and the sweep
 * proves that too. The map and the checks share these states and events, so
 * they cannot drift apart.
 *
 * Money never moves here: every `run` is a pure state transition. The
 * `movesMoney` flag marks the events whose ENGINE counterpart sends money to
 * the provider, so checks can tell a money path from a bookkeeping path. */

import type { Money } from "#payment/money.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  readyRefund,
  rearmKeyedRefund,
  returnRefundToReady,
} from "#payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
  mayReplaceRefundWithFreshEvidence,
  type RefundOwnerChoice,
  type RefundOwnerChoiceName,
  resolveRefundOwnerChoice,
} from "#payment/refund-authority-choice.ts";
import type {
  RefundAuthorityState,
  RefundRequestGeneration,
} from "#payment/refund-authority-state.ts";
import type { RefundConflictDecision } from "#payment/refund-conflict-decision.ts";
import { refundReplayUntil } from "#payment/refund-replay-window.ts";
import {
  derivedNodeIds,
  type ExpectedMove,
  type MachineEvent,
  type MachineMoves,
  type MachineMovesReader,
  type MachineNode,
  type MachineRepresentative,
  movesIn,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";

const NOW = 1_750_000_000_000;
const NEXT = NOW + 60_000;
const REQUEST_INDEX = "spec-refund-request";

/** One keyed request generation; `replayUntil` is what makes the
 * expired-window exits reachable or not. */
const keyedRequest = (
  replayUntil: number,
): Extract<RefundRequestGeneration, { capability: "keyed" }> => ({
  capability: "keyed",
  generation: 1,
  identityIndex: REQUEST_INDEX,
  replayUntil,
});
const KEYED = keyedRequest(NOW + 3_600_000);
const KEYLESS: RefundRequestGeneration = {
  capability: "keyless",
  generation: 1,
  identityIndex: REQUEST_INDEX,
};
/** A keyed request whose safe replay window has already closed. */
const EXPIRED_KEYED = keyedRequest(NOW - 1);

/** Provider evidence shapes the conflict transitions accept: exact valid
 * money fixtures, never parsed. */
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

/** The nodes of the map. `completed` splits by whether Money holds the
 * record yet, and an owner choice splits by the evidence it carries, because
 * those differences change which moves are open. */
export type RefundNodeId =
  | "check"
  | "choice_not_sent"
  | "choice_open"
  | "choice_returned"
  | "observing"
  | "ready"
  | "recorded"
  | "returned"
  | "send_armed";

/** The map node one stored state belongs to. Total: every valid state has
 * exactly one home. */
export const refundNodeOf = (state: RefundAuthorityState): RefundNodeId => {
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

/** One stored state standing for a whole family the machine must treat the
 * same way — keyed, keyless, or keyed past its replay window. */
export type RefundRepresentative = MachineRepresentative<RefundAuthorityState>;

const readyKeyed = readyRefund({
  evidenceRevision: 1,
  nextActionAt: NEXT,
  now: NOW,
  request: KEYED,
});
const readyKeyless = readyRefund({
  evidenceRevision: 1,
  nextActionAt: NEXT,
  now: NOW,
  request: KEYLESS,
});
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
const armedKeyed = armRefundSend(readyKeyed, NOW, NEXT);
const armedKeyless = armRefundSend(readyKeyless, NOW, NEXT);
const armedStates = [
  rep("keyed", armedKeyed),
  rep("keyless", armedKeyless),
  rep("keyed_expired", armedPastWindow),
];

/** The three capability families, built through the same transition. */
const family = (
  run: (state: RefundAuthorityState) => RefundAuthorityState,
): readonly RefundRepresentative[] =>
  armedStates.map(({ state, tag }) => rep(tag, run(state)));

export type RefundNode = MachineNode<RefundAuthorityState, RefundNodeId>;

/** Every node with the real states behind it — all built by the production
 * constructors, several through multi-step paths, so a representative can
 * never hold a shape the code cannot reach. */
export const REFUND_NODES: readonly RefundNode[] = [
  {
    id: "ready",
    reps: [
      rep("keyed", readyKeyed),
      rep("keyless", readyKeyless),
      // Proof of not-sent can hand back a keyed request whose window has
      // already closed; the machine must still answer for that shape.
      rep("keyed_expired", returnRefundToReady(armedPastWindow, 2, NOW, NEXT)),
    ],
  },
  { id: "send_armed", reps: armedStates },
  {
    id: "observing",
    reps: family((state) => markRefundObservationDue(state, NOW, NEXT)),
  },
  {
    // The one node with no owner or system exit: only fresh provider
    // evidence can settle an inconclusive conflict, so it may wait.
    awaits: "provider",
    id: "check",
    reps: family((state) =>
      markRefundProviderConflict(state, NOW, WAIT_EVIDENCE),
    ),
  },
  {
    id: "choice_open",
    reps: [
      rep(
        "keyless_possibly_sent",
        markRefundOwnerChoiceNeeded(armedKeyless, NOW, "possibly_sent"),
      ),
      rep(
        "keyed_rejected",
        markRefundOwnerChoiceNeeded(armedKeyed, NOW, "provider_rejected"),
      ),
      rep(
        "keyed_unreadable",
        markRefundOwnerChoiceNeeded(readyKeyed, NOW, "provider_unreadable"),
      ),
      rep(
        "keyed_window_expired",
        markRefundOwnerChoiceNeeded(
          armedPastWindow,
          NOW,
          "replay_window_expired",
        ),
      ),
    ],
  },
  {
    id: "choice_not_sent",
    reps: family((state) =>
      markRefundProviderConflict(state, NOW, NOT_SENT_EVIDENCE),
    ),
  },
  {
    id: "choice_returned",
    reps: family((state) =>
      markRefundProviderConflict(state, NOW, RETURNED_EVIDENCE),
    ),
  },
  {
    id: "returned",
    reps: family((state) => markRefundCompleted(state, NOW, "provider")),
  },
  {
    id: "recorded",
    reps: family((state) =>
      markRefundLocalRecorded(markRefundCompleted(state, NOW, "provider"), NOW),
    ),
  },
];

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

/** The not-sent owner choice, built the way the resolution route builds it:
 * the NEW generation gets a fresh replay window from the decision time —
 * never the old request's window, which may already have closed. */
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
        replayUntil: refundReplayUntil("stripe", NEXT),
      }
    : { ...common, capability: "keyless" };
};

export type RefundEventId =
  | "arm"
  | "conflict_not_sent"
  | "conflict_returned"
  | "conflict_wait"
  | "expired"
  | "observe"
  | "owner_confirms_not_sent"
  | "owner_confirms_returned"
  | "possibly_sent"
  | "proved_not_sent"
  | "provider_returned"
  | "record_in_money"
  | "rejected"
  | "replay"
  | "unreadable";

export type RefundMachineEvent = MachineEvent<
  RefundAuthorityState,
  RefundEventId
>;

/** Every way a stored refund can move, each running the real transition. */
export const REFUND_EVENTS: readonly RefundMachineEvent[] = [
  {
    actor: "system",
    id: "arm",
    labelKey: "schema.refund.edge.arm",
    movesMoney: true,
    run: (state) => armRefundSend(state, NOW, NEXT),
  },
  {
    actor: "provider",
    id: "observe",
    labelKey: "schema.refund.edge.observe",
    movesMoney: false,
    run: (state) => markRefundObservationDue(state, NOW, NEXT),
  },
  {
    actor: "system",
    id: "replay",
    labelKey: "schema.refund.edge.replay",
    movesMoney: true,
    run: (state) => rearmKeyedRefund(state, REQUEST_INDEX, NOW, NEXT),
  },
  {
    actor: "provider",
    id: "proved_not_sent",
    labelKey: "schema.refund.edge.proved_not_sent",
    movesMoney: false,
    run: (state) =>
      returnRefundToReady(state, state.evidenceRevision + 1, NOW, NEXT),
  },
  {
    actor: "provider",
    id: "provider_returned",
    labelKey: "schema.refund.edge.provider_returned",
    movesMoney: false,
    run: whenEvidenceMayReplace((state) =>
      markRefundCompleted(state, NOW, "provider"),
    ),
  },
  {
    actor: "provider",
    id: "unreadable",
    labelKey: "schema.refund.edge.unreadable",
    movesMoney: false,
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "provider_unreadable"),
  },
  {
    actor: "provider",
    id: "rejected",
    labelKey: "schema.refund.edge.rejected",
    movesMoney: false,
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "provider_rejected"),
  },
  {
    actor: "system",
    id: "expired",
    labelKey: "schema.refund.edge.expired",
    movesMoney: false,
    run: (state) =>
      markRefundOwnerChoiceNeeded(state, NOW, "replay_window_expired"),
  },
  {
    actor: "system",
    id: "possibly_sent",
    labelKey: "schema.refund.edge.possibly_sent",
    movesMoney: false,
    run: (state) => markRefundOwnerChoiceNeeded(state, NOW, "possibly_sent"),
  },
  {
    actor: "provider",
    id: "conflict_returned",
    labelKey: "schema.refund.edge.conflict_returned",
    movesMoney: false,
    run: (state) => markRefundProviderConflict(state, NOW, RETURNED_EVIDENCE),
  },
  {
    actor: "provider",
    id: "conflict_not_sent",
    labelKey: "schema.refund.edge.conflict_not_sent",
    movesMoney: false,
    run: (state) => markRefundProviderConflict(state, NOW, NOT_SENT_EVIDENCE),
  },
  {
    actor: "provider",
    id: "conflict_wait",
    labelKey: "schema.refund.edge.conflict_wait",
    movesMoney: false,
    run: (state) => markRefundProviderConflict(state, NOW, WAIT_EVIDENCE),
  },
  {
    actor: "owner",
    id: "owner_confirms_returned",
    labelKey: "schema.refund.edge.owner_confirms_returned",
    movesMoney: false,
    run: whenOwnerChoice((state) =>
      resolveRefundOwnerChoice(state, {
        decidedAt: NEXT,
        kind: "provider_confirmed_returned",
      }),
    ),
  },
  {
    actor: "owner",
    id: "owner_confirms_not_sent",
    labelKey: "schema.refund.edge.owner_confirms_not_sent",
    movesMoney: false,
    run: whenOwnerChoice((state) =>
      resolveRefundOwnerChoice(state, notSentChoice(state)),
    ),
  },
  {
    actor: "owner",
    id: "record_in_money",
    labelKey: "schema.refund.edge.record_in_money",
    movesMoney: false,
    run: (state) => markRefundLocalRecorded(state, NOW),
  },
];

/** send_armed and observing are one family to every transition — the code
 * itself guards them together (requireActiveSentRefund) — so they share one
 * declared row. */
const ACTIVE_SENT_MOVES: Readonly<
  Partial<Record<RefundEventId, ExpectedMove<RefundNodeId>>>
> = {
  conflict_not_sent: "choice_not_sent",
  conflict_returned: "choice_returned",
  conflict_wait: "check",
  expired: { perRep: { keyed_expired: "choice_open" } },
  observe: "observing",
  possibly_sent: { perRep: { keyless: "choice_open" } },
  proved_not_sent: "ready",
  provider_returned: "returned",
  rejected: "choice_open",
  replay: { perRep: { keyed: "send_armed" } },
};

/** The declared machine: for each node, the events that must move it and
 * where to. EVERY other (event × representative) pair is thereby declared a
 * refusal, and the mirror test executes all of them — nothing is skipped.
 *
 * Two recorded wrinkles, kept as-is rather than smoothed over:
 * - `ready × arm` succeeds even for a keyed request past its replay window
 *   (`armRefundSend` does not re-check the window; the engine's send
 *   admission is the gate that does).
 * - `send_armed/observing × expired` fires only for the representative whose
 *   window has actually closed — the split IS the replay-window rule. */
export const EXPECTED_MOVES: MachineMoves<RefundNodeId, RefundEventId> = {
  check: {
    conflict_not_sent: "choice_not_sent",
    conflict_returned: "choice_returned",
    conflict_wait: "check",
    provider_returned: "returned",
  },
  choice_not_sent: {
    owner_confirms_not_sent: "ready",
  },
  choice_open: {
    conflict_not_sent: "choice_not_sent",
    conflict_returned: "choice_returned",
    conflict_wait: "check",
    owner_confirms_not_sent: "ready",
    owner_confirms_returned: "returned",
    provider_returned: "returned",
  },
  choice_returned: {
    owner_confirms_returned: "returned",
  },
  observing: ACTIVE_SENT_MOVES,
  ready: {
    arm: "send_armed",
    conflict_not_sent: "choice_not_sent",
    conflict_returned: "choice_returned",
    conflict_wait: "check",
    provider_returned: "returned",
    unreadable: "choice_open",
  },
  recorded: {},
  returned: {
    record_in_money: "recorded",
  },
  send_armed: ACTIVE_SENT_MOVES,
};

/** The table's readers: the declared destination of one cell, or the one
 * plain answer a whole row of shapes shares. */
export const REFUND_MOVES: MachineMovesReader<RefundNodeId, RefundEventId> =
  movesIn(EXPECTED_MOVES);

/** The map event each owner choice fires. */
const OWNER_EVENT_FOR = {
  provider_confirmed_not_sent: "owner_confirms_not_sent",
  provider_confirmed_returned: "owner_confirms_returned",
} as const satisfies Record<RefundOwnerChoiceName, RefundEventId>;

/** The node an owner choice puts the record on, read from the open
 * decision's row of the table. The open decision offers both answers to
 * every shape, so the cell must be a plain one — a split there is a bug
 * the resolver refuses loudly. */
export const refundChoiceTarget = (
  choice: RefundOwnerChoiceName,
): RefundNodeId => REFUND_MOVES.plain("choice_open", OWNER_EVENT_FOR[choice]);

const MONEY_SENDING_NODES: ReadonlySet<RefundNodeId> = new Set(
  derivedNodeIds({
    events: REFUND_EVENTS,
    moves: EXPECTED_MOVES,
    nodes: REFUND_NODES,
  }).movedBy((event) => event.movesMoney),
);

/** Whether the machine declares any money-sending move out of this node.
 * An owner action that runs the engine in "send" mode from such a node can
 * move real money; pure evidence checks ("observe only") never can. */
export const refundNodeSendsMoney = (node: RefundNodeId): boolean =>
  MONEY_SENDING_NODES.has(node);
