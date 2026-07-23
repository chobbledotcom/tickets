import * as v from "valibot";
import { parseOrThrow } from "./parse.ts";

export interface StoredJson<TSchema extends v.GenericSchema> {
  read: (value: unknown, context: string) => v.InferOutput<TSchema>;
  write: (value: v.InferInput<TSchema>, context?: string) => string;
}

const invalidStoredJson = (
  context: string,
  detail: string,
  cause?: unknown,
): Error =>
  new Error(`Invalid stored JSON in ${context}: ${detail}`, { cause });

const INVALID_SCHEMA_DETAIL = "Stored value does not match its schema";

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
    return parseOrThrow(schema, parsed, () =>
      invalidStoredJson(context, INVALID_SCHEMA_DETAIL),
    );
  },
  write: (value, context) => {
    const output = parseOrThrow(
      schema,
      value,
      () =>
        new Error(
          `Invalid value for stored JSON${context ? ` in ${context}` : ""}`,
        ),
    );
    return JSON.stringify(output);
  },
});
