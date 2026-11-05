// effects: pure
import * as v from "valibot";

/**
 * Build a type guard from a valibot schema. `guardFor(schema)` returns
 * `(value) => value is <the schema's output>`. Every value type can then
 * declare its "is this value one of mine?" check as a single line, instead of
 * re-spelling the `(value): value is X => v.is(XSchema, value)` body by hand.
 *
 * One shared mechanism for the whole codebase's guards. It keys off the same
 * schema that is already the single source of truth for the type and options.
 */
export const guardFor =
  <TSchema extends v.GenericSchema>(schema: TSchema) =>
  (value: unknown): value is v.InferOutput<TSchema> =>
    v.is(schema, value);
