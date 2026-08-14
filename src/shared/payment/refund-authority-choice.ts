/** Required owner decisions for refund outcomes evidence cannot settle. */

import {
  type CompletedRefundState,
  markRefundCompleted,
  type NeedsOwnerChoiceRefundState,
  type ProviderConflictRefundState,
  readyRefund,
  type ReadyRefundState,
  type RefundAuthorityState,
  type RefundOwnerChoiceReason,
  type RefundRequestGeneration,
  validateRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
import type {
  RefundConflictDecision,
  RefundOwnerDecision,
} from "#shared/payment/refund-conflict-decision.ts";
import { sameMoney } from "#shared/payment/money.ts";

const OWNER_CHOICE_FROM = {
  possibly_sent: ["send_armed", "observing"],
  provider_rejected: ["send_armed", "observing"],
  provider_unreadable: ["ready"],
  replay_window_expired: ["send_armed", "observing"],
} as const satisfies Record<
  Exclude<RefundOwnerChoiceReason, "provider_conflict">,
  readonly RefundAuthorityState["kind"][]
>;

type OrdinaryOwnerChoiceReason = keyof typeof OWNER_CHOICE_FROM;
type OrdinaryOwnerChoiceRefundState = Exclude<
  NeedsOwnerChoiceRefundState,
  ProviderConflictRefundState
>;

interface OwnerChoiceFacts {
  readonly decision: RefundOwnerDecision;
  readonly evidenceRevision: number;
  readonly reason: RefundOwnerChoiceReason;
}

const ownerChoiceState = (
  state: RefundAuthorityState,
  openedAt: number,
  facts: OwnerChoiceFacts,
): NeedsOwnerChoiceRefundState =>
  validateRefundAuthorityState({
    ...facts,
    kind: "needs_owner_choice",
    local: { kind: "not_due" },
    nextActionAt: null,
    openedAt,
    request: state.request,
  }) as NeedsOwnerChoiceRefundState;

/** Stop one declared source state at its required owner decision. */
export const markRefundOwnerChoiceNeeded = (
  state: RefundAuthorityState,
  openedAt: number,
  reason: OrdinaryOwnerChoiceReason,
): OrdinaryOwnerChoiceRefundState => {
  const allowed: readonly RefundAuthorityState["kind"][] =
    OWNER_CHOICE_FROM[reason];
  if (!allowed.includes(state.kind)) {
    throw new Error(`Owner choice ${reason} cannot start from ${state.kind}`);
  }
  return ownerChoiceState(state, openedAt, {
    decision: { kind: "returned_or_not_sent" },
    evidenceRevision: state.evidenceRevision,
    reason,
  }) as OrdinaryOwnerChoiceRefundState;
};

/** Park a disagreement with its exact provider evidence. A later read may
 * replace only this same kind of owner decision. */
export const markRefundProviderConflict = (
  state: RefundAuthorityState,
  openedAt: number,
  decision: RefundConflictDecision,
): ProviderConflictRefundState => {
  if (
    state.kind === "completed" ||
    (state.kind === "needs_owner_choice" &&
      state.reason !== "provider_conflict")
  ) {
    throw new Error(`Provider conflict cannot start from ${state.kind}`);
  }
  return ownerChoiceState(state, openedAt, {
    decision,
    evidenceRevision: state.evidenceRevision + 1,
    reason: "provider_conflict",
  }) as ProviderConflictRefundState;
};

export type RefundOwnerChoice =
  | { decidedAt: number; kind: "provider_confirmed_returned" }
  | {
    capability: "keyless";
    decidedAt: number;
    evidenceRevision: number;
    kind: "provider_confirmed_not_sent";
    nextActionAt: number;
    requestIndex: string;
  }
  | {
    capability: "keyed";
    decidedAt: number;
    evidenceRevision: number;
    kind: "provider_confirmed_not_sent";
    nextActionAt: number;
    replayUntil: number;
    requestIndex: string;
  };

const nextGeneration = (
  state: NeedsOwnerChoiceRefundState,
  choice: Exclude<RefundOwnerChoice, { kind: "provider_confirmed_returned" }>,
): RefundRequestGeneration => {
  if (state.request.capability !== choice.capability) {
    throw new Error("Owner choice must keep the provider capability");
  }
  return choice.capability === "keyed"
    ? {
      capability: "keyed",
      generation: state.request.generation + 1,
      identityIndex: choice.requestIndex,
      replayUntil: choice.replayUntil,
    }
    : {
      capability: "keyless",
      generation: state.request.generation + 1,
      identityIndex: choice.requestIndex,
    };
};

export type RefundOwnerChoiceName = RefundOwnerChoice["kind"];

const OWNER_CHOICES_BY_DECISION = {
  not_sent: ["provider_confirmed_not_sent"],
  returned: ["provider_confirmed_returned"],
  returned_or_not_sent: [
    "provider_confirmed_returned",
    "provider_confirmed_not_sent",
  ],
  wait: [],
} as const satisfies Record<
  RefundOwnerDecision["kind"],
  readonly RefundOwnerChoiceName[]
>;

/** Exact choices admitted by one provider decision. A partial return proves
 * neither that the full refund finished nor that the remainder is safe to
 * send, so its only safe action is another provider check. */
export const refundOwnerChoicesForDecision = (
  decision: RefundOwnerDecision,
): readonly RefundOwnerChoiceName[] =>
  decision.kind === "returned" &&
    !sameMoney(decision.captured, decision.refunded)
    ? []
    : OWNER_CHOICES_BY_DECISION[decision.kind];

/** Exact choices admitted by the evidence stored in this authority revision. */
export const refundOwnerChoices = (
  state: NeedsOwnerChoiceRefundState,
): readonly RefundOwnerChoiceName[] =>
  refundOwnerChoicesForDecision(state.decision);

/** Apply one explicit owner answer; there is intentionally no generic clear. */
export const resolveRefundOwnerChoice = (
  state: NeedsOwnerChoiceRefundState,
  choice: RefundOwnerChoice,
): CompletedRefundState | ReadyRefundState => {
  const allowed: readonly RefundOwnerChoiceName[] = refundOwnerChoices(state);
  if (!allowed.includes(choice.kind)) {
    throw new Error(
      `Owner choice ${choice.kind} is not allowed by ${state.decision.kind}`,
    );
  }
  return choice.kind === "provider_confirmed_returned"
    ? markRefundCompleted(state, choice.decidedAt, "owner")
    : readyRefund({
      evidenceRevision: choice.evidenceRevision,
      nextActionAt: choice.nextActionAt,
      now: choice.decidedAt,
      request: nextGeneration(state, choice),
    });
};
