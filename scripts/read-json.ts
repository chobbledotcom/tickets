/**
 * Reading a JSON file that may not be there, or may be half written.
 */

import * as v from "valibot";
import { nullIfNotFound } from "#scripts/not-found.ts";

/** JSON that may have been left half-written, as data or as null. */
const parseOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    // Torn text reads as "nothing here", which every caller already handles.
    return null;
  }
};

/**
 * What the file at `path` holds, checked against `schema`. `null` means there
 * is no file, or what is there is half written or the wrong shape. A disk that
 * cannot be read at all still throws: that is not the same as "nothing here".
 */
export const readJsonOrNull = async <Schema extends v.GenericSchema>(
  path: string,
  schema: Schema,
): Promise<v.InferOutput<Schema> | null> => {
  const text = await nullIfNotFound(Deno.readTextFile(path));
  if (text === null) return null;
  const parsed = v.safeParse(schema, parseOrNull(text));
  return parsed.success ? parsed.output : null;
};
