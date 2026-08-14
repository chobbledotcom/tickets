/** Required owner decisions for refund outcomes evidence cannot settle. */

import {
  type CompletedRefundState,
  markRefundCompleted,
  type NeedsOwnerChoiceRefundState,
  type ReadyRefundState,
  type RefundAuthorityState,
  type RefundOwnerChoiceReason,
  type RefundRequestGeneration,
  readyRefund,
  validateRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";

const OWNER_CHOICE_FROM = {
  possibly_sent: ["send_armed", "observing"],
  provider_conflict: ["ready", "send_armed", "observing"],
  provider_rejected: ["send_armed", "observing"],
  provider_unreadable: ["ready"],
  replay_window_expired: ["send_armed", "observing"],
} as const satisfies Record<
  RefundOwnerChoiceReason,
  readonly RefundAuthorityState["kind"][]
>;

/** Stop one declared source state at its required owner decision. */
export const markRefundOwnerChoiceNeeded = (
  state: RefundAuthorityState,
  openedAt: number,
  reason: RefundOwnerChoiceReason,
): NeedsOwnerChoiceRefundState => {
  const allowed: readonly RefundAuthorityState["kind"][] =
    OWNER_CHOICE_FROM[reason];
  if (!allowed.includes(state.kind)) {
    throw new Error(`Owner choice ${reason} cannot start from ${state.kind}`);
  }
  const choice = {
    evidenceRevision: state.evidenceRevision,
    kind: "needs_owner_choice",
    local: { kind: "not_due" },
    nextActionAt: null,
    openedAt,
    reason,
    request: state.request,
  } as const;
  return validateRefundAuthorityState(choice) as NeedsOwnerChoiceRefundState;
};

export type RefundOwnerChoice =
  | { decidedAt: number; kind: "provider_confirms_returned" }
  | {
      capability: "keyless";
      decidedAt: number;
      evidenceRevision: number;
      kind: "provider_confirms_not_sent";
      nextActionAt: number;
      requestIndex: string;
    }
  | {
      capability: "keyed";
      decidedAt: number;
      evidenceRevision: number;
      kind: "provider_confirms_not_sent";
      nextActionAt: number;
      replayUntil: number;
      requestIndex: string;
    };

const nextGeneration = (
  state: NeedsOwnerChoiceRefundState,
  choice: Exclude<RefundOwnerChoice, { kind: "provider_confirms_returned" }>,
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

/** Apply one explicit owner answer; there is intentionally no generic clear. */
export const resolveRefundOwnerChoice = (
  state: NeedsOwnerChoiceRefundState,
  choice: RefundOwnerChoice,
): CompletedRefundState | ReadyRefundState =>
  choice.kind === "provider_confirms_returned"
    ? markRefundCompleted(state, choice.decidedAt, "owner")
    : readyRefund({
        evidenceRevision: choice.evidenceRevision,
        nextActionAt: choice.nextActionAt,
        now: choice.decidedAt,
        request: nextGeneration(state, choice),
      });
