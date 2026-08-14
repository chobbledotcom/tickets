/** Required owner decisions for refund outcomes evidence cannot settle. */

import { sameMoney } from "#shared/payment/money.ts";
import {
  markRefundCompleted,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { refundEvidenceActionAllowed } from "#shared/payment/refund-authority-lifecycle.ts";
import {
  type CompletedRefundState,
  type NeedsOwnerChoiceRefundState,
  type NeedsProviderCheckRefundState,
  type ProviderConflictOwnerChoiceRefundState,
  type ReadyRefundState,
  type RefundAuthorityState,
  type RefundOwnerChoiceReason,
  type RefundRequestGeneration,
  validateRefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import {
  type RefundConflictDecision,
  type RefundOwnerDecision,
  refundConflictNeedsProviderCheck,
} from "#shared/payment/refund-conflict-decision.ts";

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
  ProviderConflictOwnerChoiceRefundState
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

type ProviderConflictState =
  | NeedsProviderCheckRefundState
  | ProviderConflictOwnerChoiceRefundState;

const FRESH_EVIDENCE_REPLACES_OWNER_REASON = {
  possibly_sent: true,
  provider_conflict: false,
  provider_rejected: true,
  provider_unreadable: true,
  replay_window_expired: true,
} as const satisfies Record<RefundOwnerChoiceReason, boolean>;

/** Whether newer provider evidence may replace this exact stored judgment. */
export const mayReplaceRefundWithFreshEvidence = (
  state: RefundAuthorityState,
): boolean =>
  refundEvidenceActionAllowed(state.kind, "replace_with_fresh_evidence") &&
  (state.kind !== "needs_owner_choice" ||
    FRESH_EVIDENCE_REPLACES_OWNER_REASON[state.reason]);

/** Park a disagreement with its exact provider evidence. Only evidence that
 * cannot support a decision remains open for another provider check. */
export const markRefundProviderConflict = (
  state: RefundAuthorityState,
  openedAt: number,
  decision: RefundConflictDecision,
): ProviderConflictState => {
  if (!mayReplaceRefundWithFreshEvidence(state)) {
    throw new Error(`Provider conflict cannot start from ${state.kind}`);
  }
  return validateRefundAuthorityState({
    decision,
    evidenceRevision: state.evidenceRevision + 1,
    kind: refundConflictNeedsProviderCheck(decision)
      ? "needs_provider_check"
      : "needs_owner_choice",
    local: { kind: "not_due" },
    nextActionAt: null,
    openedAt,
    reason: "provider_conflict",
    request: state.request,
  }) as ProviderConflictState;
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

export type RefundOwnerChoices = readonly [
  RefundOwnerChoiceName,
  ...RefundOwnerChoiceName[],
];

/** Exact choices admitted by the evidence stored in this authority revision. */
export const refundOwnerChoices = (
  state: NeedsOwnerChoiceRefundState,
): RefundOwnerChoices => {
  const decision: RefundOwnerDecision = state.decision;
  if (decision.kind === "returned_or_not_sent") {
    return ["provider_confirmed_returned", "provider_confirmed_not_sent"];
  }
  if (decision.kind === "not_sent") {
    return ["provider_confirmed_not_sent"];
  }
  if (
    decision.kind === "returned" &&
    sameMoney(decision.captured, decision.refunded)
  ) {
    return ["provider_confirmed_returned"];
  }
  throw new Error("Owner-choice refund state does not admit a decision");
};

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
