import * as v from "valibot";

/**
 * A positive integer in plain decimal form — digits only, so no sign, no
 * leading `+`, no surrounding whitespace, and not zero.
 *
 * The app reads listing ids out of dynamic form keys like `select_<id>` and
 * `qty_<id>`, where a lenient `Number.parseInt` would otherwise accept junk
 * such as `"5abc"` as `5`. Validating the digits before coercing closes that.
 *
 * Mirrors the schema + parse-helper shape of validation/email.ts and
 * validation/date.ts as the rest of the app's validation migrates to valibot.
 */
const PositiveIntIdSchema = v.pipe(
  v.string(),
  v.digits(),
  v.transform(Number),
  v.minValue(1),
);

/** Parse a strict positive-integer id from a string, or null when it isn't one. */
export const parsePositiveIntId = (value: string): number | null => {
  const result = v.safeParse(PositiveIntIdSchema, value);
  return result.success ? result.output : null;
};
