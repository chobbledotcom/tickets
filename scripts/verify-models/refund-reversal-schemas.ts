/* One valibot fact schema per fact record, with the TypeScript type and the
 * checker record type both derived from it. The `tlaFields` helper maps each
 * valibot field to its checker type, so a schema change moves every consumer
 * at once. */

import * as v from "valibot";

type ValibotNode = { type: string };

/** The checker type one valibot field declares. */
const tlaTypeOf = (schema: ValibotNode): "Str" | "Bool" | "Int" => {
  if (schema.type === "string" || schema.type === "picklist") return "Str";
  if (schema.type === "boolean") return "Bool";
  if (schema.type === "number") return "Int";
  throw new Error(`Unsupported valibot type for a fact field: ${schema.type}`);
};

/** The checker record fields for one valibot object schema. */
const tlaFields = (schema: {
  entries: Readonly<Record<string, ValibotNode>>;
}) =>
  Object.fromEntries(
    Object.entries(schema.entries).map(([field, fieldSchema]) => [
      field,
      tlaTypeOf(fieldSchema),
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
