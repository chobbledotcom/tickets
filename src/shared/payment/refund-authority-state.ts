// effects: pure
/** The validated, stored shapes for one provider refund authority. */

import * as v from "valibot";
import {
  RefundConflictDecisionSchema,
  ReturnedOrNotSentDecisionSchema,
  refundConflictNeedsProviderCheck,
} from "#payment/refund-conflict-decision.ts";
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

const RefundRequestGenerationSchema = v.variant("capability", [
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

const RefundLocalStateSchema = v.variant("kind", [
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

const CompletedRefundStateSchema = v.union([
  CompletedDueRefundStateSchema,
  CompletedRecordedRefundStateSchema,
]);

const attentionFields = {
  evidenceRevision: integerAtLeast(1),
  local: NotDueSchema,
  nextActionAt: v.null(),
  openedAt: TimeSchema,
  request: RefundRequestGenerationSchema,
};

const ownerChoiceFields = {
  ...attentionFields,
  kind: v.literal("needs_owner_choice"),
};

const OrdinaryOwnerChoiceRefundStateSchema = v.pipe(
  v.strictObject({
    ...ownerChoiceFields,
    decision: ReturnedOrNotSentDecisionSchema,
    reason: v.picklist([
      "possibly_sent",
      "provider_rejected",
      "provider_unreadable",
      "replay_window_expired",
    ]),
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

const providerConflictStateSchema = <
  const Kind extends "needs_owner_choice" | "needs_provider_check",
>(
  kind: Kind,
  needsProviderCheck: boolean,
  message: string,
) =>
  v.pipe(
    v.strictObject({
      ...attentionFields,
      decision: RefundConflictDecisionSchema,
      kind: v.literal(kind),
      reason: v.literal("provider_conflict"),
    }),
    v.check(
      (state) =>
        refundConflictNeedsProviderCheck(state.decision) === needsProviderCheck,
      message,
    ),
  );

const ProviderConflictOwnerChoiceRefundStateSchema =
  providerConflictStateSchema(
    "needs_owner_choice",
    false,
    "An owner-choice conflict must admit an owner decision",
  );

const NeedsProviderCheckRefundStateSchema = providerConflictStateSchema(
  "needs_provider_check",
  true,
  "A provider-check state must carry evidence that cannot be decided yet",
);

const NeedsOwnerChoiceRefundStateSchema = v.union([
  OrdinaryOwnerChoiceRefundStateSchema,
  ProviderConflictOwnerChoiceRefundStateSchema,
]);

const RefundAuthorityStateSchema = v.union([
  ReadyRefundStateSchema,
  SendArmedRefundStateSchema,
  ObservingRefundStateSchema,
  CompletedRefundStateSchema,
  NeedsOwnerChoiceRefundStateSchema,
  NeedsProviderCheckRefundStateSchema,
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
export type RefundOwnerChoiceReason = NeedsOwnerChoiceRefundState["reason"];
export type NeedsProviderCheckRefundState = Extract<
  RefundAuthorityState,
  { kind: "needs_provider_check" }
>;
export type ProviderConflictOwnerChoiceRefundState = Extract<
  NeedsOwnerChoiceRefundState,
  { reason: "provider_conflict" }
>;

/** An owner choice that any provider evidence can open, without a conflict. */
export type OrdinaryOwnerChoiceRefundState = Exclude<
  NeedsOwnerChoiceRefundState,
  ProviderConflictOwnerChoiceRefundState
>;

/** When the provider finished returning this money, or null before then.
 * Total over every state, so callers that know the money came back can take
 * the instant through `requireValue` without an unreachable branch. */
export const completedAtOf = (state: RefundAuthorityState): number | null =>
  state.kind === "completed" ? state.completedAt : null;

const storedState = defineStoredJson(RefundAuthorityStateSchema);

export const readRefundAuthorityState = storedState.read;

export const writeRefundAuthorityState = storedState.write;

/** Read one state through the schema for its own shape. A transition builder
 *  then returns the kind it parsed, so a wrong shape is a compile error or a
 *  thrown error, never an unchecked cast. */
const stateReader =
  <State>(schema: v.GenericSchema<unknown, State>) =>
  (state: unknown): State =>
    v.parse(schema, state);

export const validateReadyRefundState = stateReader<ReadyRefundState>(
  ReadyRefundStateSchema,
);
export const validateSendArmedRefundState = stateReader<SendArmedRefundState>(
  SendArmedRefundStateSchema,
);
export const validateObservingRefundState = stateReader<ObservingRefundState>(
  ObservingRefundStateSchema,
);
export const validateCompletedRefundState = stateReader<CompletedRefundState>(
  CompletedRefundStateSchema,
);
export const validateOwnerChoiceRefundState =
  stateReader<OrdinaryOwnerChoiceRefundState>(
    OrdinaryOwnerChoiceRefundStateSchema,
  );
export const validateProviderConflictRefundState =
  stateReader<ProviderConflictOwnerChoiceRefundState>(
    ProviderConflictOwnerChoiceRefundStateSchema,
  );
export const validateNeedsProviderCheckRefundState =
  stateReader<NeedsProviderCheckRefundState>(
    NeedsProviderCheckRefundStateSchema,
  );

export const refundStateMirror = (
  state: RefundAuthorityState,
): RefundAuthorityStateName => state.kind;

export const refundLocalMirror = (
  state: RefundAuthorityState,
): RefundLocalState["kind"] => state.local.kind;

export const refundNextActionAt = (
  state: RefundAuthorityState,
): number | null => state.nextActionAt;
