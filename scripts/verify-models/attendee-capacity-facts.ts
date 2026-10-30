/** The checker fact shapes for the attendee capacity model. Each fact record
 *  has one valibot schema: the schema supplies the TS record type, and the
 *  derived type note feeds the TLA checker set. */

import * as v from "valibot";

/** One line's fact for the checker: which batch and slot it belongs to, its
 *  quantity, its edit kind, and the production capacity decision. */
export const lineFieldsSchema = v.object({
  batch: v.string(),
  fits: v.boolean(),
  kind: v.picklist(["delete", "insert", "preserve", "update"]),
  listing: v.picklist(["one", "two"]),
  quantity: v.number(),
});
export type LineFact = v.InferOutput<typeof lineFieldsSchema>;

/** One batch's fact for the checker: its slot totals and line count after
 *  the batch, whether it commits, and whether it holds only preserves. */
export const batchFieldsSchema = v.object({
  batch: v.string(),
  commits: v.boolean(),
  lineCountAfter: v.number(),
  preserveOnly: v.boolean(),
  slot1AfterTotal: v.number(),
  slot2AfterTotal: v.number(),
});
export type BatchFact = v.InferOutput<typeof batchFieldsSchema>;

/** The checker type note for one valibot object schema: each field becomes a
 *  TLA primitive type, so one declaration drives both the TS record and the
 *  checker set. */
export const tlaSchemaOf = <T extends v.ObjectEntries>(
  schema: v.ObjectSchema<T, undefined>,
): Record<string, "Int" | "Bool" | "Str"> => {
  const entries = Object.entries(schema.entries) as [
    string,
    { type: string },
  ][];
  return Object.fromEntries(
    entries.map(([name, field]) => [
      name,
      field.type === "number"
        ? "Int"
        : field.type === "boolean"
          ? "Bool"
          : "Str",
    ]),
  );
};

export const lineTlaSchema = tlaSchemaOf(lineFieldsSchema);
export const batchTlaSchema = tlaSchemaOf(batchFieldsSchema);
