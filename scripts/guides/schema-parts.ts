/** The stable names and trimmed text every guide document uses. Kept in one
 * place so a storyboard, a timeline, and a baseline cannot disagree about what
 * a capture id looks like. */

import * as v from "valibot";

/** A capture id, a guide slug, or a Cucumber case id. */
export const StableIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "Invalid stable id"),
);

export const NonEmptyTextSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** A parser for one document schema: it validates any value against it. */
export const parserFor =
  <Schema extends v.GenericSchema>(schema: Schema) =>
  (input: unknown): v.InferOutput<Schema> =>
    v.parse(schema, input);
