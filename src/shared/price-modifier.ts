/**
 * The price-modifier calc engine.
 *
 * A modifier changes an order's price by one of three rules — a generalisation
 * of the reservation-amount mini-language. The value is *signed*: a negative
 * fixed/percent value is a discount, and a multiply factor below 1 reduces the
 * price while above 1 increases it. Rounding matches the booking fee
 * (`Math.round` to the nearest minor unit) so totals stay consistent across
 * the pricing pipeline.
 *
 * The calc itself is pure: it knows how a single rule transforms a base amount,
 * nothing about carts, stock, or persistence.
 */

import * as v from "valibot";

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

/** Type guard: is the string a valid modifier trigger? */
export const isModifierTrigger = (value: string): value is ModifierTrigger =>
  v.is(ModifierTriggerSchema, value);

/** Which cart items a modifier is charged on: the whole order, specific
 * listings, or every listing in specific groups. */
export const ModifierScopeSchema = v.picklist(["all", "listings", "groups"]);
export type ModifierScope = v.InferOutput<typeof ModifierScopeSchema>;

/** Type guard: is the string a valid modifier scope? */
export const isModifierScope = (value: string): value is ModifierScope =>
  v.is(ModifierScopeSchema, value);

/** Normalise a promo code for storage and matching: trimmed and lower-cased so
 * codes are case-insensitive. The blind index is the HMAC of this. */
export const normalizeCode = (code: string): string =>
  code.trim().toLowerCase();

/** Type guard: is the string a valid calc kind? */
export const isCalcKind = (value: string): value is CalcKind =>
  v.is(CalcKindSchema, value);

/** Type guard: is the string a valid modifier direction? */
export const isModifierDirection = (
  value: string,
): value is ModifierDirection => v.is(ModifierDirectionSchema, value);

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
 * separate field): a percentage above 0 up to 100, a multiplier above 0, or a
 * fixed amount above 0. A zero value is a no-op modifier, so it is rejected for
 * every kind. Returns an error message, or null when valid.
 */
export const validateCalcValue = (
  kind: CalcKind,
  value: number,
): string | null => {
  if (!Number.isFinite(value)) return "Enter a valid number";
  if (kind === "percent") {
    return value > 0 && value <= 100
      ? null
      : "Percentage must be greater than 0 and at most 100";
  }
  if (kind === "multiply") {
    return value > 0 ? null : "Multiplier must be greater than 0";
  }
  return value > 0 ? null : "Amount must be greater than 0";
};
