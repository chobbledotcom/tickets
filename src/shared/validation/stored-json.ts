import * as v from "valibot";

export interface StoredJson<TSchema extends v.GenericSchema> {
  read: (value: unknown, context: string) => v.InferOutput<TSchema>;
  write: (value: v.InferInput<TSchema>, context?: string) => string;
}

const invalidStoredJson = (
  context: string,
  detail: string,
  cause: unknown,
): Error =>
  new Error(`Invalid stored JSON in ${context}: ${detail}`, { cause });

/** Define one schema-backed JSON format for both storage reads and writes. */
export const defineStoredJson = <TSchema extends v.GenericSchema>(
  schema: TSchema,
): StoredJson<TSchema> => ({
  read: (value, context) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.parse(v.string(), value));
    } catch (error) {
      throw invalidStoredJson(context, String(error), error);
    }
    const result = v.safeParse(schema, parsed);
    if (!result.success) {
      throw invalidStoredJson(
        context,
        result.issues[0]!.message,
        result.issues,
      );
    }
    return result.output;
  },
  write: (value, context) => {
    const result = v.safeParse(schema, value);
    if (!result.success) {
      throw new Error(
        `Invalid value for stored JSON${context ? ` in ${context}` : ""}`,
        { cause: result.issues },
      );
    }
    return JSON.stringify(result.output);
  },
});
