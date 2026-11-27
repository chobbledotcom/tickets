// effects: pure
import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";

const ratedPolicy = <Mode extends "add_to_total" | "calculate_from_total">(
  mode: Mode,
) =>
  v.strictObject({ mode: v.literal(mode), rateBasisPoints: integerAtLeast(0) });

export const TaxPolicySchema = v.variant("mode", [
  v.strictObject({ mode: v.literal("none") }),
  ratedPolicy("add_to_total"),
  ratedPolicy("calculate_from_total"),
]);
export type TaxPolicy = v.InferOutput<typeof TaxPolicySchema>;
export const NO_TAX: TaxPolicy = { mode: "none" };

const TaxLineSchema = v.strictObject({
  gross: integerAtLeast(0),
  listingId: integerAtLeast(1),
});
/** A taxable one-off charge a booking carries beside its priced lines, such as
 * delivery. It has no listing or modifier of its own. The API refuses a charge
 * that is not positive, so only an included-tax share can bring one to zero. */
const TaxChargeSchema = v.strictObject({ gross: integerAtLeast(0) });
const TaxModifierSchema = v.strictObject({
  delta: integerAtLeast(Number.MIN_SAFE_INTEGER),
  modifierId: integerAtLeast(1),
});
/** The priced lines, taxable charges and modifier deltas one tax computation
 * carries. The assessment embeds this group as its basis and repeats the
 * lists at the top level of the stored object. A stored assessment from
 * before charges existed has none. */
const TaxEntriesSchema = {
  charges: v.optional(v.array(TaxChargeSchema), []),
  lines: v.array(TaxLineSchema),
  modifiers: v.array(TaxModifierSchema),
};
export const TaxBasisSchema = v.strictObject(TaxEntriesSchema);
export type TaxBasis = v.InferOutput<typeof TaxBasisSchema>;
/** A basis as a caller writes it: the charges can be left out. */
export type TaxBasisInput = v.InferInput<typeof TaxBasisSchema>;

export const TaxAssessmentSchema = v.strictObject({
  basis: TaxBasisSchema,
  ...TaxEntriesSchema,
  policy: TaxPolicySchema,
  taxAmount: integerAtLeast(0),
  taxableTotal: integerAtLeast(0),
  total: integerAtLeast(0),
});
export type TaxAssessment = v.InferOutput<typeof TaxAssessmentSchema>;
