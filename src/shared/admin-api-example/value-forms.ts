// effects: pure
/**
 * The value forms that more than one write declares. The module imports no
 * runtime code, so a route can declare its body keys without loading the docs.
 */

import type { ValueForm } from "./field-docs.ts";

export const TEXT: ValueForm = { form: "text" };

/** A list whose entries are objects with these keys. */
export const listOfObjects = (names: readonly string[]): ValueForm => ({
  form: "list_of",
  of: { form: "object", names },
});
