// effects: pure
/** The pure, durable life of one provider-qualified refund request. */

import {
  type CompletedRefundState,
  type ObservingRefundState,
  type ReadyRefundState,
  type RefundAuthorityState,
  type RefundRequestGeneration,
  type SendArmedRefundState,
  validateCompletedRefundState,
  validateObservingRefundState,
  validateReadyRefundState,
  validateSendArmedRefundState,
} from "#payment/refund-authority-state.ts";

export type ActiveSentRefundState = SendArmedRefundState | ObservingRefundState;
type AutomaticRefundState = ReadyRefundState | ActiveSentRefundState;

/** Require a generation that can already be past the provider boundary. */
export const requireActiveSentRefund = (
  state: RefundAuthorityState,
  message: string,
): ActiveSentRefundState => {
  if (state.kind !== "send_armed" && state.kind !== "observing") {
    throw new Error(message);
  }
  return state;
};

/** The instant each active kind records. It is the one field that no other
 *  active state has, so the shared builder writes the right field for its
 *  kind. */
const ACTIVE_INSTANT_FIELD = {
  observing: "lastObservedAt",
  ready: "readyAt",
  send_armed: "armedAt",
} as const satisfies {
  readonly [Kind in AutomaticRefundState["kind"]]: Exclude<
    keyof Extract<AutomaticRefundState, { kind: Kind }>,
    keyof Exclude<AutomaticRefundState, { kind: Kind }>
  >;
};

/** Build one active state, then read it back through the schema for its kind. */
const buildActiveState = <State extends AutomaticRefundState>(
  read: (state: unknown) => State,
  kind: AutomaticRefundState["kind"],
  state: AutomaticRefundState,
  at: number,
  nextActionAt: number,
): State =>
  read({
    evidenceRevision: state.evidenceRevision,
    kind,
    local: { kind: "not_due" },
    nextActionAt,
    request: state.request,
    [ACTIVE_INSTANT_FIELD[kind]]: at,
  });

export interface ReadyRefundFacts {
  readonly evidenceRevision: number;
  readonly nextActionAt: number;
  readonly now: number;
  readonly request: RefundRequestGeneration;
}

/** Start one generation that evidence says is safe to attempt. */
export const readyRefund = (facts: ReadyRefundFacts): ReadyRefundState => {
  if (
    facts.request.capability === "keyed" &&
    facts.request.replayUntil < facts.now
  ) {
    throw new Error("A keyed refund cannot start outside its replay window");
  }
  return validateReadyRefundState({
    evidenceRevision: facts.evidenceRevision,
    kind: "ready",
    local: { kind: "not_due" },
    nextActionAt: facts.nextActionAt,
    readyAt: facts.now,
    request: facts.request,
  });
};

/** Persist that this exact generation can be at the provider boundary. */
export const armRefundSend = (
  state: RefundAuthorityState,
  armedAt: number,
  nextActionAt: number,
): SendArmedRefundState => {
  if (state.kind !== "ready") throw new Error("Refund is not ready to arm");
  return buildActiveState(
    validateSendArmedRefundState,
    "send_armed",
    state,
    armedAt,
    nextActionAt,
  );
};

/** Keep an armed generation observation-only until more evidence arrives. */
export const markRefundObservationDue = (
  state: RefundAuthorityState,
  observedAt: number,
  nextActionAt: number,
): ObservingRefundState => {
  const active = requireActiveSentRefund(
    state,
    "Refund is not armed for observation",
  );
  return buildActiveState(
    validateObservingRefundState,
    "observing",
    active,
    observedAt,
    nextActionAt,
  );
};

/** Re-arm only the same keyed generation inside its finite provider window. */
export const rearmKeyedRefund = (
  state: RefundAuthorityState,
  requestIndex: string,
  armedAt: number,
  nextActionAt: number,
): SendArmedRefundState => {
  if (state.request.capability === "keyless") {
    throw new Error("A keyless refund can never replay automatically");
  }
  if (state.request.identityIndex !== requestIndex) {
    throw new Error("A keyed refund may replay only its exact request");
  }
  if (armedAt > state.request.replayUntil) {
    throw new Error("A keyed refund is outside its replay window");
  }
  const active = requireActiveSentRefund(
    state,
    "Refund is not armed for a keyed replay",
  );
  return buildActiveState(
    validateSendArmedRefundState,
    "send_armed",
    active,
    armedAt,
    nextActionAt,
  );
};

/** A conclusive not-sent result makes this same generation safe again. */
export const returnRefundToReady = (
  state: RefundAuthorityState,
  evidenceRevision: number,
  readyAt: number,
  nextActionAt: number,
): ReadyRefundState => {
  const active = requireActiveSentRefund(
    state,
    "Refund is not armed, so it cannot be proved not sent",
  );
  const ready = buildActiveState(
    validateReadyRefundState,
    "ready",
    active,
    readyAt,
    nextActionAt,
  );
  return validateReadyRefundState({
    ...ready,
    evidenceRevision,
  });
};

/** Provider evidence proves the cash returned. Local recording is now due. */
export const markRefundCompleted = (
  state: RefundAuthorityState,
  completedAt: number,
  proof: "owner" | "provider",
): CompletedRefundState => {
  if (state.kind === "completed") {
    throw new Error("Refund is already completed");
  }
  return validateCompletedRefundState({
    completedAt,
    evidenceRevision: state.evidenceRevision,
    kind: "completed",
    local: { kind: "due", returnedAt: completedAt },
    nextActionAt: completedAt,
    proof,
    request: state.request,
  });
};

/** Finish the separate local bookkeeping after returned cash is recorded. */
export const markRefundLocalRecorded = (
  state: RefundAuthorityState,
  recordedAt: number,
): CompletedRefundState => {
  if (state.kind !== "completed" || state.local.kind !== "due") {
    throw new Error("Refund is not waiting for local recording");
  }
  return validateCompletedRefundState({
    ...state,
    local: { kind: "recorded", recordedAt, returnedAt: state.local.returnedAt },
    nextActionAt: null,
  });
};
