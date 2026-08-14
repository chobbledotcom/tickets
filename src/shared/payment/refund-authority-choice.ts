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
  requireActiveSentRefund,
  validateRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";

/** Stop an armed generation at its required owner decision. */
export const markRefundOwnerChoiceNeeded = (
  state: RefundAuthorityState,
  openedAt: number,
  reason: RefundOwnerChoiceReason,
): NeedsOwnerChoiceRefundState => {
  const active = requireActiveSentRefund(
    state,
    "Owner choice requires an armed refund",
  );
  const choice = {
    evidenceRevision: active.evidenceRevision,
    kind: "needs_owner_choice",
    local: { kind: "not_due" },
    nextActionAt: null,
    openedAt,
    reason,
    request: active.request,
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
