import * as v from "valibot";
import { parseOrNull } from "./parse.ts";
import { NonEmptyTextSchema } from "./string.ts";

/** A safe whole number no lower than `minimum`. */
export const integerAtLeast = (
  minimum: number,
): v.GenericSchema<number, number> =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(minimum));

/** Clamp safe whole numbers to a range. Malformed numbers still throw. */
export const clampInteger = (
  minimum: number,
  maximum: number,
): ((value: number) => number) => {
  const integerSchema = integerAtLeast(Number.MIN_SAFE_INTEGER);
  return (value) =>
    Math.max(minimum, Math.min(maximum, v.parse(integerSchema, value)));
};

/**
 * Plain decimal integer strings: digits only, so no sign, fraction, exponent,
 * or trailing junk. The public helpers trim first.
 *
 * The app reads listing ids out of dynamic form keys like `select_<id>` and
 * `qty_<id>`, where a lenient `Number.parseInt` accepts `"5abc"` as `5`.
 * Validation of the digits before the coercion closes that.
 */
const NonNegativeIntSchema = v.pipe(
  NonEmptyTextSchema,
  v.digits(),
  v.transform(Number),
  v.safeInteger(),
);
const PositiveIntSchema = v.pipe(NonNegativeIntSchema, v.minValue(1));
type IntSchema = v.GenericSchema<string, number>;

const parseIntWithSchema = (schema: IntSchema, value: string): number | null =>
  parseOrNull(schema, value.trim());

/** Parse a strict non-negative decimal integer, or null when it isn't one. */
export const parseNonNegativeInt = (value: string): number | null =>
  parseIntWithSchema(NonNegativeIntSchema, value);

/** Parse a strict positive decimal integer, or null when it isn't one. */
export const parsePositiveInt = (value: string): number | null =>
  parseIntWithSchema(PositiveIntSchema, value);

/** Whether a number can be stored safely as a positive database id. */
export const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;
