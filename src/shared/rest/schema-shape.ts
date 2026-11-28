// effects: pure
/** The neutral shape of one valibot schema: the parts that the admin docs and
 *  the CLI describe command both read. A schema this walker cannot name keeps
 *  its valibot type, so a caller can say what it refused. */

import type * as v from "valibot";

/** One valibot schema's shape. */
export type SchemaShape =
  | { kind: "array"; item: SchemaShape }
  | { kind: "boolean" }
  | { kind: "nullable"; of: SchemaShape }
  | { kind: "number" }
  | { entries: Record<string, SchemaShape>; kind: "object" }
  | { kind: "optional"; of: SchemaShape }
  | { kind: "picklist"; options: readonly string[] }
  | { kind: "string" }
  | { kind: "unknown"; type: string };

/** Read the shape of one valibot schema. */
export const schemaShape = (schema: v.GenericSchema): SchemaShape => {
  switch (schema.type) {
    case "array":
      return {
        item: schemaShape(
          (schema as v.ArraySchema<v.GenericSchema, undefined>).item,
        ),
        kind: "array",
      };
    case "boolean":
      return { kind: "boolean" };
    case "nullable":
    case "optional":
      return {
        kind: schema.type,
        of: schemaShape(
          (schema as v.OptionalSchema<v.GenericSchema, undefined>).wrapped,
        ),
      };
    case "number":
      return { kind: "number" };
    case "object": {
      const entries = (schema as v.ObjectSchema<v.ObjectEntries, undefined>)
        .entries;
      return {
        entries: Object.fromEntries(
          Object.entries(entries).map(([key, entry]) => [
            key,
            schemaShape(entry),
          ]),
        ),
        kind: "object",
      };
    }
    case "picklist":
      return {
        kind: "picklist",
        options: (schema as v.PicklistSchema<readonly string[], undefined>)
          .options,
      };
    case "string":
      return { kind: "string" };
    default:
      return { kind: "unknown", type: schema.type };
  }
};
