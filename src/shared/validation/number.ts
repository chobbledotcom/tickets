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
export const NonNegativeIntSchema = v.pipe(
  NonEmptyTextSchema,
  v.digits(),
  v.transform(Number),
  v.safeInteger(),
);
const PositiveIntSchema = v.pipe(NonNegativeIntSchema, v.minValue(1));
type IntSchema = v.GenericSchema<string, number>;

const parseIntWithSchema = (schema: IntSchema, value: string): number | null =>
  parseOrNull(schema, value.trim());

/** One integer parser for the given schema, trimming first. */
const parseIntWith =
  (schema: IntSchema) =>
  (value: string): number | null =>
    parseIntWithSchema(schema, value);

/** Parse a strict non-negative decimal integer, or null when it is not one. */
export const parseNonNegativeInt = parseIntWith(NonNegativeIntSchema);

/** Parse a strict positive decimal integer, or null when it is not one. */
export const parsePositiveInt = parseIntWith(PositiveIntSchema);

/**
 * Plain signed decimal integer strings: an optional minus, then digits only,
 * so no fraction, exponent, or trailing junk. The public helper trims first.
 *
 * The attendee form reads payment and adjustment amounts out of text inputs,
 * where a lenient `Number` accepts `"1e3"` and `" 5 "`. Validation of the
 * digits before the coercion closes that. The adjustment amount is signed (a
 * negative forgives part of the debt), so the sign is part of the shape.
 */
const SignedIntSchema = v.pipe(
  NonEmptyTextSchema,
  v.regex(/^-?\d+$/),
  v.transform(Number),
  v.safeInteger(),
);

/** Parse a strict signed decimal integer, or null when it is not one. */
export const parseSignedInt = parseIntWith(SignedIntSchema);

/** Whether a number can be stored safely as a positive database id. */
export const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;
