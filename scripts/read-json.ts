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

/** Torn text reads as "nothing here", which every caller already handles. */
const parseOrNull = parseJsonWith(() => null);

/**
 * Reads the JSON at the file named by `path`, validated against `schema`.
 * `Missing` names what an unreadable or wrong-shaped file becomes.
 */
type SchemaRead<Missing = never> = <Schema extends v.GenericSchema>(
  path: string,
  schema: Schema,
) => Promise<v.InferOutput<Schema> | Missing>;

/**
 * What the file at `path` holds, checked against `schema`. `null` means there
 * is no file, or what is there is half written or the wrong shape. A disk that
 * cannot be read at all still throws: that is not the same as "nothing here".
 */
export const readJsonOrNull: SchemaRead<null> = async (path, schema) => {
  const text = await nullIfNotFound(Deno.readTextFile(path));
  if (text === null) return null;
  const parsed = v.safeParse(schema, parseOrNull(text));
  return parsed.success ? parsed.output : null;
};

/**
 * What the file at `path` holds, checked against `schema`. A required file
 * that is not there, or does not match the schema, fails loudly: reading it
 * as empty would read as a clean run.
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
 * insertion, and newline-terminated.
 */
export const writeJsonFile = (path: string, value: unknown): Promise<void> =>
  Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
