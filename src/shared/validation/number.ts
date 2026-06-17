import * as v from "valibot";

/**
 * Plain decimal integer strings. The schemas accept digits only, so no signs,
 * fractions, exponent notation, or trailing junk. Public helpers trim before
 * validating, so callers can pass raw form/query values without repeating that
 * at every boundary.
 *
 * The app reads listing ids out of dynamic form keys like `select_<id>` and
 * `qty_<id>`, where a lenient `Number.parseInt` would otherwise accept junk
 * such as `"5abc"` as `5`. Validating the digits before coercing closes that.
 *
 * Mirrors the schema + parse-helper shape of validation/email.ts and
 * validation/date.ts as the rest of the app's validation migrates to valibot.
 */
const NonNegativeIntSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.digits(),
  v.transform(Number),
  v.minValue(0),
);

const PositiveIntSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.digits(),
  v.transform(Number),
  v.minValue(1),
);

/** Parse a strict positive-integer id from a string, or null when it isn't one. */
export const parsePositiveIntId = (value: string): number | null => {
  const result = v.safeParse(PositiveIntSchema, value.trim());
  return result.success ? result.output : null;
};

/** Parse a strict non-negative decimal integer, or null when it isn't one. */
export const parseNonNegativeInt = (value: string): number | null => {
  const result = v.safeParse(NonNegativeIntSchema, value.trim());
  return result.success ? result.output : null;
};

/** Parse a strict positive decimal integer, or null when it isn't one. */
export const parsePositiveInt = (value: string): number | null => {
  const result = v.safeParse(PositiveIntSchema, value.trim());
  return result.success ? result.output : null;
};
