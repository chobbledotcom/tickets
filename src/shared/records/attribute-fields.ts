/** The attribute fields: the stored row, the API bodies, and the JSON body
 *  read derive from this one list. */

import type { FieldSpecs } from "#shared/rest/field-specs.ts";

export const ATTRIBUTE_FIELDS = [
  { key: "name", kind: "name" },
] as const satisfies FieldSpecs;
