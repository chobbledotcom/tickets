/**
 * Reading a JSON file that may not be there, or may be half written.
 */

import * as v from "valibot";
import { nullIfNotFound } from "#scripts/not-found.ts";

/** Parse JSON text, and let the caller decide what a torn text becomes. */
export const parseJsonWith =
  (onParseError: (error: unknown) => unknown) =>
  (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      return onParseError(error);
    }
  };

/**
 * Reads the JSON at the file named by `path`, validated against `schema`.
 * `Missing` names what an unreadable or wrong-shaped file becomes.
 */
type SchemaRead<Missing = never> = <Schema extends v.GenericSchema>(
  path: string,
  schema: Schema,
) => Promise<v.InferOutput<Schema> | Missing>;

/** What torn text reads as, distinct from any value a parse can produce. */
const torn = Symbol("torn text");

/**
 * What the file at `path` holds, checked against `schema`. `null` means there
 * is no file, or what is there is half written or the wrong shape. A disk that
 * cannot be read at all still throws: that is not the same as "nothing here".
 *
 * A file that holds valid JSON `null` for a schema that accepts it is
 * refused loudly: this API uses `null` as its unread marker, so a null value
 * would read as missing. A torn text is checked before the schema ever sees
 * it, so a half-written file still reads as `null` even for null-accepting
 * schemas.
 */
export const readJsonOrNull: SchemaRead<null> = async (path, schema) => {
  const text = await nullIfNotFound(Deno.readTextFile(path));
  if (text === null) return null;
  const json = parseJsonWith(() => torn)(text);
  if (json === torn) return null;
  const parsed = v.safeParse(schema, json);
  if (parsed.success && parsed.output === null) {
    throw new Error(
      `The JSON at ${path} holds null, which this API uses as its "nothing" marker. ` +
        "Wrap the value (for example in an object) so it can never read as missing.",
    );
  }
  return parsed.success ? parsed.output : null;
};

/**
 * What the file at `path` holds, checked against `schema`. A file that is
 * not there, or is half written, or is the wrong shape, fails loudly: a
 * required registry that reads as empty would read as a clean run.
 *
 * The file must not hold valid JSON `null` for a schema that accepts it:
 * this API uses `null` as its unread marker, so a null value would read as
 * missing. Schemas like `v.null()` are refused here rather than conflated.
 */
export const readJsonOrThrow: SchemaRead = async (path, schema) => {
  const read = await readJsonOrNull(path, schema);
  if (read === null) {
    throw new Error(`Cannot read the JSON at ${path}.`);
  }
  return read;
};

/**
 * Write `value` at `path` as JSON a person reviews: indented, sorted by
 * insertion, and newline-terminated. A value that does not serialize —
 * `undefined`, a function, a symbol — fails here rather than writing
 * invalid JSON.
 */
export const writeJsonFile = async (
  path: string,
  value: unknown,
): Promise<void> => {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new Error(`Cannot write JSON to ${path}: the value has no JSON.`);
  }
  await Deno.writeTextFile(path, `${text}\n`);
};
