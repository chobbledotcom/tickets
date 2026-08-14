/** The pure, durable life of one provider-qualified refund request. */

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const TimeSchema = integerAtLeast(0);

const keyedRequestSchema = v.strictObject({
  capability: v.literal("keyed"),
  generation: integerAtLeast(1),
  identityIndex: NonEmptyTextSchema,
  replayUntil: TimeSchema,
});

const keylessRequestSchema = v.strictObject({
  capability: v.literal("keyless"),
  generation: integerAtLeast(1),
  identityIndex: NonEmptyTextSchema,
});

export const RefundRequestGenerationSchema = v.variant("capability", [
  keyedRequestSchema,
  keylessRequestSchema,
]);
export type RefundRequestGeneration = v.InferOutput<
  typeof RefundRequestGenerationSchema
>;

const NotDueSchema = v.strictObject({ kind: v.literal("not_due") });
const DueSchema = v.strictObject({
  kind: v.literal("due"),
  returnedAt: TimeSchema,
});
const RecordedSchema = v.strictObject({
  kind: v.literal("recorded"),
  recordedAt: TimeSchema,
  returnedAt: TimeSchema,
});

export const RefundLocalStateSchema = v.variant("kind", [
  NotDueSchema,
  DueSchema,
  RecordedSchema,
]);
export type RefundLocalState = v.InferOutput<typeof RefundLocalStateSchema>;

const activeFields = {
  evidenceRevision: integerAtLeast(1),
  local: NotDueSchema,
  nextActionAt: TimeSchema,
  request: RefundRequestGenerationSchema,
};

const ReadyRefundStateSchema = v.strictObject({
  ...activeFields,
  kind: v.literal("ready"),
  readyAt: TimeSchema,
});
const SendArmedRefundStateSchema = v.strictObject({
  ...activeFields,
  armedAt: TimeSchema,
  kind: v.literal("send_armed"),
});
const ObservingRefundStateSchema = v.strictObject({
  ...activeFields,
  kind: v.literal("observing"),
  lastObservedAt: TimeSchema,
});
const completedFields = {
  completedAt: TimeSchema,
  evidenceRevision: integerAtLeast(1),
  kind: v.literal("completed"),
  proof: v.picklist(["owner", "provider"]),
  request: RefundRequestGenerationSchema,
};
const CompletedDueRefundStateSchema = v.pipe(
  v.strictObject({
    ...completedFields,
    local: DueSchema,
    nextActionAt: TimeSchema,
  }),
  v.check(
    (state) => state.nextActionAt === state.local.returnedAt,
    "Returned money must make its local recording due now",
  ),
);
const CompletedRecordedRefundStateSchema = v.strictObject({
  ...completedFields,
  local: RecordedSchema,
  nextActionAt: v.null(),
});

export const RefundOwnerChoiceReasonSchema = v.picklist([
  "possibly_sent",
  "provider_conflict",
  "provider_unreadable",
  "replay_window_expired",
  "provider_rejected",
]);
export type RefundOwnerChoiceReason = v.InferOutput<
  typeof RefundOwnerChoiceReasonSchema
>;

const NeedsOwnerChoiceRefundStateSchema = v.pipe(
  v.strictObject({
    evidenceRevision: integerAtLeast(1),
    kind: v.literal("needs_owner_choice"),
    local: NotDueSchema,
    nextActionAt: v.null(),
    openedAt: TimeSchema,
    reason: RefundOwnerChoiceReasonSchema,
    request: RefundRequestGenerationSchema,
  }),
  v.check(
    (state) =>
      state.reason === "possibly_sent"
        ? state.request.capability === "keyless"
        : state.reason !== "replay_window_expired" ||
          (state.request.capability === "keyed" &&
            state.openedAt > state.request.replayUntil),
    "Owner choice reason does not match the refund request",
  ),
);

export const RefundAuthorityStateSchema = v.union([
  ReadyRefundStateSchema,
  SendArmedRefundStateSchema,
  ObservingRefundStateSchema,
  CompletedDueRefundStateSchema,
  CompletedRecordedRefundStateSchema,
  NeedsOwnerChoiceRefundStateSchema,
]);
export type RefundAuthorityState = v.InferOutput<
  typeof RefundAuthorityStateSchema
>;
export type RefundAuthorityStateName = RefundAuthorityState["kind"];
export type ReadyRefundState = Extract<RefundAuthorityState, { kind: "ready" }>;
export type SendArmedRefundState = Extract<
  RefundAuthorityState,
  { kind: "send_armed" }
>;
export type ObservingRefundState = Extract<
  RefundAuthorityState,
  { kind: "observing" }
>;
export type CompletedRefundState = Extract<
  RefundAuthorityState,
  { kind: "completed" }
>;
export type NeedsOwnerChoiceRefundState = Extract<
  RefundAuthorityState,
  { kind: "needs_owner_choice" }
>;

export type ActiveSentRefundState = SendArmedRefundState | ObservingRefundState;

const storedState = defineStoredJson(RefundAuthorityStateSchema);

export const readRefundAuthorityState = (
  value: unknown,
  context: string,
): RefundAuthorityState => storedState.read(value, context);

export const writeRefundAuthorityState = (
  state: RefundAuthorityState,
  context?: string,
): string => storedState.write(state, context);

export const validateRefundAuthorityState = (
  state: RefundAuthorityState,
): RefundAuthorityState => v.parse(RefundAuthorityStateSchema, state);

/** Require a generation which may already have crossed the provider boundary. */
export const requireActiveSentRefund = (
  state: RefundAuthorityState,
  message: string,
): ActiveSentRefundState => {
  if (state.kind !== "send_armed" && state.kind !== "observing") {
    throw new Error(message);
  }
  return state;
};

const activeState = (
  kind: "ready" | "send_armed" | "observing",
  state: RefundAuthorityState,
  atName: "armedAt" | "lastObservedAt" | "readyAt",
  at: number,
  nextActionAt: number,
): RefundAuthorityState => {
  if (state.kind === "completed") {
    throw new Error("A completed refund cannot return to active work");
  }
  if (state.kind === "needs_owner_choice") {
    throw new Error("A refund awaiting its owner cannot resume automatically");
  }
  return validateRefundAuthorityState({
    evidenceRevision: state.evidenceRevision,
    kind,
    local: { kind: "not_due" },
    nextActionAt,
    request: state.request,
    [atName]: at,
  } as RefundAuthorityState);
};

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
  return validateRefundAuthorityState({
    evidenceRevision: facts.evidenceRevision,
    kind: "ready",
    local: { kind: "not_due" },
    nextActionAt: facts.nextActionAt,
    readyAt: facts.now,
    request: facts.request,
  }) as ReadyRefundState;
};

/** Persist that this exact generation may be at the provider boundary. */
export const armRefundSend = (
  state: RefundAuthorityState,
  armedAt: number,
  nextActionAt: number,
): SendArmedRefundState => {
  if (state.kind !== "ready") throw new Error("Refund is not ready to arm");
  return activeState(
    "send_armed",
    state,
    "armedAt",
    armedAt,
    nextActionAt,
  ) as SendArmedRefundState;
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
  return activeState(
    "observing",
    active,
    "lastObservedAt",
    observedAt,
    nextActionAt,
  ) as ObservingRefundState;
};

/** Whether the same keyed request may still be repeated exactly. */
export const mayReplayKeyedRefund = (
  state: RefundAuthorityState,
  requestIndex: string,
  now: number,
): boolean =>
  (state.kind === "send_armed" || state.kind === "observing") &&
  state.request.capability === "keyed" &&
  state.request.identityIndex === requestIndex &&
  now <= state.request.replayUntil;

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
  return activeState(
    "send_armed",
    active,
    "armedAt",
    armedAt,
    nextActionAt,
  ) as SendArmedRefundState;
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
  const ready = activeState(
    "ready",
    active,
    "readyAt",
    readyAt,
    nextActionAt,
  ) as ReadyRefundState;
  return validateRefundAuthorityState({
    ...ready,
    evidenceRevision,
  }) as ReadyRefundState;
};

/** Provider evidence proves the cash returned; local recording is now due. */
export const markRefundCompleted = (
  state: RefundAuthorityState,
  completedAt: number,
  proof: "owner" | "provider",
): CompletedRefundState => {
  if (state.kind === "completed") {
    throw new Error("Refund is already completed");
  }
  return validateRefundAuthorityState({
    completedAt,
    evidenceRevision: state.evidenceRevision,
    kind: "completed",
    local: { kind: "due", returnedAt: completedAt },
    nextActionAt: completedAt,
    proof,
    request: state.request,
  }) as CompletedRefundState;
};

/** Finish the separate local bookkeeping after returned cash is recorded. */
export const markRefundLocalRecorded = (
  state: RefundAuthorityState,
  recordedAt: number,
): CompletedRefundState => {
  if (state.kind !== "completed" || state.local.kind !== "due") {
    throw new Error("Refund is not waiting for local recording");
  }
  return validateRefundAuthorityState({
    ...state,
    local: { kind: "recorded", recordedAt, returnedAt: state.local.returnedAt },
    nextActionAt: null,
  }) as CompletedRefundState;
};

export const refundStateMirror = (
  state: RefundAuthorityState,
): RefundAuthorityStateName => state.kind;

export const refundLocalMirror = (
  state: RefundAuthorityState,
): RefundLocalState["kind"] => state.local.kind;

export const refundNextActionAt = (
  state: RefundAuthorityState,
): number | null => state.nextActionAt;
