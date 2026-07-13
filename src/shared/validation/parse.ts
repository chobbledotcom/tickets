import * as v from "valibot";

/**
 * Run a valibot schema and give back its parsed value, or `null` when the input
 * does not pass. This is the single "try to parse, else null" step every
 * null-on-invalid parser in this folder is built on (money, number, …), so the
 * `v.safeParse` call and its success check live in exactly one place.
 */
export const parseOrNull = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> | null => {
  const result = v.safeParse(schema, input);
  return result.success ? result.output : null;
};
