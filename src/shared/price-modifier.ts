/**
 * The value is *signed*: a negative fixed or percent value is a discount, and a
 * multiply factor below 1 reduces the price.
 *
 * Rounding matches the booking fee, to the nearest minor unit, so totals stay
 * consistent across the pricing pipeline.
 *
 * Pure: it knows how one rule transforms a base amount, and nothing about
 * carts, stock, or persistence.
 */

import * as v from "valibot";
import { toMinorUnits } from "#shared/currency.ts";

/** How a modifier's value is interpreted against the base amount. */
export const CalcKindSchema = v.picklist(["fixed", "percent", "multiply"]);
export type CalcKind = v.InferOutput<typeof CalcKindSchema>;

/** Whether a modifier adds to the price or reduces it (the owner-facing sign,
 * applied when a modifier is resolved for a checkout). Ignored for `multiply`,
 * whose factor already encodes direction (< 1 reduces, > 1 raises). */
export const ModifierDirectionSchema = v.picklist(["charge", "discount"]);
export type ModifierDirection = v.InferOutput<typeof ModifierDirectionSchema>;

/** How a modifier becomes part of a checkout: applied automatically, unlocked
 * by a promo code, an opt-in add-on the buyer chooses, or attached to the
 * answer(s) of a custom question, applying when the buyer selects one. */
export const ModifierTriggerSchema = v.picklist([
  "automatic",
  "code",
  "optional",
  "answer",
]);
export type ModifierTrigger = v.InferOutput<typeof ModifierTriggerSchema>;

/** Which cart items a modifier is charged on: the whole order, specific
 * listings, or every listing in specific groups. */
export const ModifierScopeSchema = v.picklist(["all", "listings", "groups"]);
export type ModifierScope = v.InferOutput<typeof ModifierScopeSchema>;

export type CalcValueError =
  | "modifiers.error.amount_positive"
  | "modifiers.error.invalid_number"
  | "modifiers.error.multiplier_positive"
  | "modifiers.error.percent_charge_range"
  | "modifiers.error.percent_positive"
  | "modifiers.error.percent_range";

/** Largest percentage charge an operator may save. This keeps later price
 * arithmetic bounded while allowing surcharges far above 100%. */
export const MAX_PERCENT_CHARGE = 10_000;

interface PercentRule {
  max: number;
  nonPositiveError: CalcValueError;
  tooLargeError: CalcValueError;
}

const PERCENT_RULES = {
  charge: {
    max: MAX_PERCENT_CHARGE,
    nonPositiveError: "modifiers.error.percent_positive",
    tooLargeError: "modifiers.error.percent_charge_range",
  },
  discount: {
    max: 100,
    nonPositiveError: "modifiers.error.percent_range",
    tooLargeError: "modifiers.error.percent_range",
  },
} as const satisfies Record<ModifierDirection, PercentRule>;

const validatePercent = (
  value: number,
  direction: ModifierDirection,
): CalcValueError | null => {
  const rule = PERCENT_RULES[direction];
  if (value <= 0) return rule.nonPositiveError;
  return value <= rule.max ? null : rule.tooLargeError;
};

/** Normalise a promo code for storage and matching: trimmed and lower-cased so
 * codes are case-insensitive. The blind index is the HMAC of this. */
export const normalizeCode = (code: string): string =>
  code.trim().toLowerCase();

/**
 * The signed value the engine applies, from a modifier's stored magnitude and
 * direction. A multiplier ignores direction, because its factor already carries
 * it. A fixed amount is entered in major currency units, so it is converted
 * here. Both the live resolver and the API snapshot read a modifier this way,
 * so the rule cannot drift between them.
 */
export const signedModifierValue = (calc: {
  direction: ModifierDirection;
  kind: CalcKind;
  value: number;
}): number => {
  if (calc.kind === "multiply") return calc.value;
  const magnitude =
    calc.kind === "fixed" ? toMinorUnits(calc.value) : calc.value;
  return calc.direction === "discount" ? -magnitude : magnitude;
};

/**
 * The signed price change (minor units) a modifier makes to `base`:
 *  - `fixed`:    a flat amount, independent of `base` (negative = discount)
 *  - `percent`:  `value`% of `base` (negative `value` = discount)
 *  - `multiply`: scales `base` to `base * value` (factor < 1 reduces, > 1 raises)
 */
export const modifierDelta = (
  base: number,
  kind: CalcKind,
  value: number,
): number => {
  if (kind === "fixed") return value;
  if (kind === "percent") return Math.round((base * value) / 100);
  return Math.round(base * value) - base;
};

/**
 * Validate the magnitude an owner entered for a modifier, given its kind.
 * The value is a positive magnitude (the charge/discount direction is a
 * separate field): a percentage above 0 (capped at 100 for discounts), a
 * multiplier above 0, or a fixed amount above 0. A zero value is a no-op
 * modifier, so it is rejected for every kind. Returns an error message, or null
 * when valid.
 */
export const validateCalcValue = (
  kind: CalcKind,
  value: number,
  direction: ModifierDirection,
): CalcValueError | null => {
  if (!Number.isFinite(value)) return "modifiers.error.invalid_number";
  if (kind === "percent") return validatePercent(value, direction);
  if (kind === "multiply") {
    return value > 0 ? null : "modifiers.error.multiplier_positive";
  }
  return value > 0 ? null : "modifiers.error.amount_positive";
};
