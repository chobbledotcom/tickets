import * as v from "valibot";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type {
  EnvKeyEncrypted,
  KeyEncrypted,
  OwnerKeyEncrypted,
  WrappedKey,
} from "#shared/crypto/sealed.ts";
import {
  PaymentProviderSchema,
  type PaymentProviderType,
} from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { isInstant } from "#shared/validation/timestamp.ts";

const InstantSchema = v.pipe(
  v.string(),
  v.check(isInstant, "Legacy payment time must be a real instant"),
);
const NonEmptyTextSchema = v.pipe(v.string(), v.nonEmpty(), v.regex(/\S/u));
const sealedSchema = <Value extends string>(prefix: string) =>
  v.custom<Value>(
    (value) => typeof value === "string" && value.startsWith(prefix),
  );
const EnvCiphertextSchema = sealedSchema<EnvKeyEncrypted>("enc:1:");
const KeyCiphertextSchema = sealedSchema<KeyEncrypted>("enc:1:");
const OwnerCiphertextSchema = sealedSchema<OwnerKeyEncrypted>("hyb:1:");
const WrappedKeySchema = sealedSchema<WrappedKey>("wk:1:");
const EnvCiphertextOrEmptySchema = v.union([
  v.literal(""),
  EnvCiphertextSchema,
]);
const OwnerCiphertextOrEmptySchema = v.union([
  v.literal(""),
  OwnerCiphertextSchema,
]);

export const LegacyProcessedPaymentSchema = v.pipe(
  v.strictObject({
    attendeeId: v.nullable(integerAtLeast(1)),
    failureData: EnvCiphertextOrEmptySchema,
    listingId: v.optional(v.nullable(integerAtLeast(1)), null),
    paymentReference: OwnerCiphertextOrEmptySchema,
    paymentSessionId: NonEmptyTextSchema,
    processedAt: InstantSchema,
    providerRefundedAt: v.union([v.literal(""), InstantSchema]),
    ticketTokens: EnvCiphertextOrEmptySchema,
  }),
  v.check(
    (row) => row.attendeeId === null || row.failureData === "",
    "A legacy payment cannot be both completed and failed",
  ),
  v.check(
    (row) => row.providerRefundedAt === "" || row.paymentReference !== "",
    "A legacy provider refund requires a payment reference",
  ),
  v.check(
    (row) => (row.attendeeId === null) === (row.listingId === null),
    "A completed legacy payment requires one live booking",
  ),
);
export type LegacyProcessedPayment = v.InferOutput<
  typeof LegacyProcessedPaymentSchema
>;

export const LegacyCheckoutStageSchema = v.strictObject({
  attendeeId: integerAtLeast(1),
  createdAt: InstantSchema,
  paymentSessionId: NonEmptyTextSchema,
  provider: PaymentProviderSchema,
  state: v.picklist(["pending", "refunding"]),
  ticketTokens: EnvCiphertextSchema,
});
export type LegacyCheckoutStage = v.InferOutput<
  typeof LegacyCheckoutStageSchema
>;

export const LegacySumupCheckoutSchema = v.strictObject({
  createdAt: InstantSchema,
  metadata: KeyCiphertextSchema,
  referenceIndex: NonEmptyTextSchema,
  sumupId: v.string(),
  wrappedKey: WrappedKeySchema,
});
export type LegacySumupCheckout = v.InferOutput<
  typeof LegacySumupCheckoutSchema
>;

export const LegacyAttendeePaymentSchema = v.strictObject({
  attendeeId: integerAtLeast(1),
  createdAt: InstantSchema,
  paymentReference: OwnerCiphertextSchema,
  source: v.picklist(["attendee_merge", "attendees.pii_blob"]),
});
export type LegacyAttendeePayment = v.InferOutput<
  typeof LegacyAttendeePaymentSchema
>;

export const LegacyPaymentRuntimeSchema = v.pipe(
  v.strictObject({
    attendeePayment: v.nullable(LegacyAttendeePaymentSchema),
    checkoutStage: v.nullable(LegacyCheckoutStageSchema),
    processedPayment: v.nullable(LegacyProcessedPaymentSchema),
    sumupCheckout: v.nullable(LegacySumupCheckoutSchema),
  }),
  v.check(
    (runtime) => Object.values(runtime).some((value) => value !== null),
    "Legacy payment runtime must contain a source row",
  ),
);
export type LegacyPaymentRuntime = v.InferOutput<
  typeof LegacyPaymentRuntimeSchema
>;

export type LegacyPaymentRows = {
  attendeePayments: LegacyAttendeePayment[];
  checkoutStages: LegacyCheckoutStage[];
  processedPayments: LegacyProcessedPayment[];
  sumupCheckouts: LegacySumupCheckout[];
};

export type LegacyPaymentGroup = {
  key: string;
  runtime: LegacyPaymentRuntime;
};

const emptyRuntime = (): LegacyPaymentRuntime => ({
  attendeePayment: null,
  checkoutStage: null,
  processedPayment: null,
  sumupCheckout: null,
});

const requireFreeSource = (
  group: LegacyPaymentGroup,
  source: keyof LegacyPaymentRuntime,
): void => {
  if (group.runtime[source] !== null) {
    throw new Error(`Legacy payment ${group.key} has two ${source} rows`);
  }
};

const mergeGroups = (
  groups: Map<string, LegacyPaymentGroup>,
  target: LegacyPaymentGroup,
  source: LegacyPaymentGroup,
): LegacyPaymentGroup => {
  if (target === source) return target;
  for (const name of Object.keys(source.runtime) as Array<
    keyof LegacyPaymentRuntime
  >) {
    const value = source.runtime[name];
    if (value === null) continue;
    requireFreeSource(target, name);
    Object.assign(target.runtime, { [name]: value });
  }
  for (const [alias, group] of groups) {
    if (group === source) groups.set(alias, target);
  }
  return target;
};

export const mergeLegacyPaymentRows = async (
  rows: LegacyPaymentRows,
): Promise<LegacyPaymentGroup[]> => {
  const groups = new Map<string, LegacyPaymentGroup>();
  const sessionGroup = (key: string): LegacyPaymentGroup => {
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created = { key, runtime: emptyRuntime() };
    groups.set(key, created);
    return created;
  };
  for (const processedPayment of rows.processedPayments) {
    const group = sessionGroup(`session:${processedPayment.paymentSessionId}`);
    requireFreeSource(group, "processedPayment");
    group.runtime.processedPayment = processedPayment;
  }
  for (const checkoutStage of rows.checkoutStages) {
    const group = sessionGroup(`session:${checkoutStage.paymentSessionId}`);
    requireFreeSource(group, "checkoutStage");
    group.runtime.checkoutStage = checkoutStage;
  }
  const sumupStages = new Map<string, LegacyPaymentGroup>();
  for (const checkoutStage of rows.checkoutStages) {
    if (checkoutStage.provider === "sumup") {
      sumupStages.set(
        await hmacHash(checkoutStage.paymentSessionId),
        sessionGroup(`session:${checkoutStage.paymentSessionId}`),
      );
    }
  }
  for (const sumupCheckout of rows.sumupCheckouts) {
    const localGroup = sumupStages.get(sumupCheckout.referenceIndex);
    const providerGroup = groups.get(`session:${sumupCheckout.sumupId}`);
    const group =
      localGroup !== undefined && providerGroup !== undefined
        ? mergeGroups(groups, localGroup, providerGroup)
        : (localGroup ??
          providerGroup ??
          sessionGroup(`sumup:${sumupCheckout.referenceIndex}`));
    requireFreeSource(group, "sumupCheckout");
    group.runtime.sumupCheckout = sumupCheckout;
  }
  for (const attendeePayment of rows.attendeePayments) {
    const group = sessionGroup(`attendee:${attendeePayment.attendeeId}`);
    requireFreeSource(group, "attendeePayment");
    group.runtime.attendeePayment = attendeePayment;
  }
  return [...new Set(groups.values())].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
};

export type LegacySessionFields = {
  attendeeId: number | null;
  completionState: "none" | "legacy_unknown";
  createdAt: number;
  provider: PaymentProviderType | null;
  result: string | null;
  resultState: "none" | "succeeded" | "failed";
  state:
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "refunding"
    | "needs_action";
  ticketState: "none" | "ready" | "consumed";
  ticketTokens: string | null;
  updatedAt: number;
};

const hasCompletedAttendee = (
  processed: LegacyProcessedPayment | null,
): boolean => processed !== null && processed.attendeeId !== null;

const checkLegacyGroup = (group: LegacyPaymentGroup): void => {
  const { checkoutStage, processedPayment, sumupCheckout } = group.runtime;
  if (
    checkoutStage !== null &&
    processedPayment !== null &&
    processedPayment.attendeeId !== null &&
    checkoutStage.attendeeId !== processedPayment.attendeeId
  ) {
    throw new Error(`Legacy payment ${group.key} has conflicting attendees`);
  }
  if (
    sumupCheckout !== null &&
    checkoutStage !== null &&
    checkoutStage.provider !== "sumup"
  ) {
    throw new Error(`Legacy payment ${group.key} has conflicting providers`);
  }
};

const legacyState = (
  runtime: LegacyPaymentRuntime,
): LegacySessionFields["state"] => {
  const processed = runtime.processedPayment;
  if (hasCompletedAttendee(processed)) return "completed";
  if (processed?.failureData) return "failed";
  if (processed !== null) return "processing";
  if (runtime.attendeePayment !== null) return "needs_action";
  return runtime.checkoutStage?.state === "refunding" ? "refunding" : "pending";
};

const legacyTimes = (runtime: LegacyPaymentRuntime): number[] =>
  [
    runtime.processedPayment?.processedAt,
    runtime.checkoutStage?.createdAt,
    runtime.sumupCheckout?.createdAt,
    runtime.attendeePayment?.createdAt,
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse);

const legacyResult = (
  processed: LegacyProcessedPayment | null,
  completed: boolean,
): Pick<LegacySessionFields, "result" | "resultState"> => ({
  result:
    processed === null || processed.failureData === ""
      ? null
      : processed.failureData,
  resultState: completed
    ? "succeeded"
    : processed?.failureData
      ? "failed"
      : "none",
});

const legacyTickets = (
  runtime: LegacyPaymentRuntime,
  completed: boolean,
): Pick<LegacySessionFields, "ticketState" | "ticketTokens"> => {
  const ticketTokens =
    runtime.processedPayment?.ticketTokens ||
    runtime.checkoutStage?.ticketTokens ||
    null;
  return {
    ticketState:
      ticketTokens !== null ? "ready" : completed ? "consumed" : "none",
    ticketTokens,
  };
};

export const legacySessionFields = (
  group: LegacyPaymentGroup,
): LegacySessionFields => {
  checkLegacyGroup(group);
  const { attendeePayment, checkoutStage, processedPayment, sumupCheckout } =
    group.runtime;
  const attendeeId =
    processedPayment?.attendeeId ??
    checkoutStage?.attendeeId ??
    attendeePayment?.attendeeId ??
    null;
  const provider =
    checkoutStage === null
      ? sumupCheckout === null
        ? null
        : "sumup"
      : checkoutStage.provider;
  const createdTimes = legacyTimes(group.runtime);
  const completed = hasCompletedAttendee(processedPayment);
  return {
    attendeeId,
    completionState: completed ? "legacy_unknown" : "none",
    createdAt: Math.min(...createdTimes),
    provider,
    ...legacyResult(processedPayment, completed),
    state: legacyState(group.runtime),
    ...legacyTickets(group.runtime, completed),
    updatedAt: Math.max(...createdTimes),
  };
};
