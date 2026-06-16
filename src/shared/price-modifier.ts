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
 * This module is intentionally dependency-free and pure: it knows how a single
 * rule transforms a base amount, nothing about carts, stock, or persistence.
 */

/** How a modifier's value is interpreted against the base amount. */
export type CalcKind = "fixed" | "percent" | "multiply";

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
