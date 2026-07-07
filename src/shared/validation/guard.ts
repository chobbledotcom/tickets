import * as v from "valibot";

/**
 * Build a string type guard from a valibot schema. `guardFor(schema)` returns
 * `(value) => value is <the schema's output>`, so every picklist value type can
 * declare its "is this string one of my members?" check as a single line
 * instead of re-spelling the `(s): s is X => v.is(XSchema, s)` body by hand.
 *
 * One shared mechanism for the whole codebase's enum guards, keyed off the same
 * schema that is already the single source of truth for the type and options.
 */
export const guardFor =
  <TSchema extends v.GenericSchema<string>>(schema: TSchema) =>
  (value: string): value is v.InferOutput<TSchema> =>
    v.is(schema, value);
