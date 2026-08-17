/** The validated, stored shapes for one provider refund authority. */

import * as v from "valibot";
import {
  RefundConflictDecisionSchema,
  ReturnedOrNotSentDecisionSchema,
  refundConflictNeedsProviderCheck,
} from "#shared/payment/refund-conflict-decision.ts";
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
  CompletedDueRefundStateSchema,
  CompletedRecordedRefundStateSchema,
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

/** When the provider finished returning this money, or null before then.
 * Total over every state, so callers that know the money came back can take
 * the instant through `requireValue` without an unreachable branch. */
export const completedAtOf = (state: RefundAuthorityState): number | null =>
  state.kind === "completed" ? state.completedAt : null;

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
  state: unknown,
): RefundAuthorityState => v.parse(RefundAuthorityStateSchema, state);

export const refundStateMirror = (
  state: RefundAuthorityState,
): RefundAuthorityStateName => state.kind;

export const refundLocalMirror = (
  state: RefundAuthorityState,
): RefundLocalState["kind"] => state.local.kind;

export const refundNextActionAt = (
  state: RefundAuthorityState,
): number | null => state.nextActionAt;
