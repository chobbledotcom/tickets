import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";

export const TaxModeSchema = v.picklist([
  "none",
  "add_to_total",
  "calculate_from_total",
]);
export type TaxMode = v.InferOutput<typeof TaxModeSchema>;

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
const TaxModifierSchema = v.strictObject({
  delta: integerAtLeast(Number.MIN_SAFE_INTEGER),
  modifierId: integerAtLeast(1),
});
export const TaxBasisSchema = v.strictObject({
  lines: v.array(TaxLineSchema),
  modifiers: v.array(TaxModifierSchema),
});
export type TaxBasis = v.InferOutput<typeof TaxBasisSchema>;

export const TaxAssessmentSchema = v.strictObject({
  basis: TaxBasisSchema,
  lines: v.array(TaxLineSchema),
  modifiers: v.array(TaxModifierSchema),
  policy: TaxPolicySchema,
  taxAmount: integerAtLeast(0),
  taxableTotal: integerAtLeast(0),
  total: integerAtLeast(0),
});
export type TaxAssessment = v.InferOutput<typeof TaxAssessmentSchema>;
