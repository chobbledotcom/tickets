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

/** Parse with a schema or throw the caller's domain-specific error. */
export const parseOrThrow = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
  invalid: () => Error,
): v.InferOutput<TSchema> => {
  const result = v.safeParse(schema, input);
  if (!result.success) throw invalid();
  return result.output;
};

/** Read a JSON document's text and check it against the schema — for response
 * bodies and other JSON text that must be both parseable and well-shaped. A
 * torn text or a wrong shape throws loudly. */
export const parseJson = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  text: string,
): v.InferOutput<TSchema> => v.parse(schema, JSON.parse(text));
