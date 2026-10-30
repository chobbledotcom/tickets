/* One valibot fact schema per fact record, with the TypeScript type and the
 * checker record type both derived from it. The `tlaFields` helper maps each
 * valibot field to its checker type, so a schema change moves every consumer
 * at once. */

import * as v from "valibot";

/** The valibot field kinds one fact field may declare. Any other kind fails
 *  to typecheck here, so the checker record types cannot drift. */
type CheckerField = { readonly type: "boolean" | "picklist" | "string" };

/** The checker record fields for one valibot object schema: a boolean field
 *  carries Bool, a string or picklist field carries Str. */
const tlaFields = (schema: {
  entries: Readonly<Record<string, CheckerField>>;
}): Readonly<Record<string, "Str" | "Bool">> =>
  Object.fromEntries(
    Object.entries(schema.entries).map(([field, fieldSchema]) => [
      field,
      fieldSchema.type === "boolean" ? "Bool" : "Str",
    ]),
  );

export const ReversalFactSchema = v.object({
  alreadyRecorded: v.boolean(),
  group: v.string(),
  hasOperatorMoney: v.boolean(),
  hasProviderPayment: v.boolean(),
  paymentOnly: v.boolean(),
  reverses: v.boolean(),
  settled: v.boolean(),
});
export type ReversalFact = v.InferOutput<typeof ReversalFactSchema>;
export const reversalFields = tlaFields(ReversalFactSchema);

export const LegFactSchema = v.object({
  exactInverse: v.boolean(),
  group: v.string(),
});
export type LegFact = v.InferOutput<typeof LegFactSchema>;
export const legFields = tlaFields(LegFactSchema);

export const ReferenceOutcomesSchema = v.picklist([
  "recorded",
  "review",
  "unrecorded",
]);

export const ReferenceFactSchema = v.object({
  outcome: ReferenceOutcomesSchema,
  reference: v.string(),
});
export type ReferenceFact = v.InferOutput<typeof ReferenceFactSchema>;
export const referenceFields = tlaFields(ReferenceFactSchema);

/** The three fact sets one plan derives, in the shape the checker reads. */
export type Facts = {
  readonly legs: readonly LegFact[];
  readonly references: readonly ReferenceFact[];
  readonly reversals: readonly ReversalFact[];
};
