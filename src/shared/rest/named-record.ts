/**
 * The common declaration of a record whose row and input both carry a `name`.
 * The display name, the log name, and the confirmation column are the same
 * fact on every such record. They are filled here.
 */

import {
  defineRecord,
  type RecordDefiner,
  type RecordShape,
} from "#shared/rest/record.ts";

/** A record whose row and input both carry its display name. */
type NamedShape = RecordShape & {
  row: { id: number; name: string };
  input: { name: string };
};

export const defineNamedRowRecord =
  <Shape extends NamedShape>(): RecordDefiner<
    Shape,
    "logName" | "nameField" | "nameOf"
  > =>
  (spec) =>
    defineRecord<Shape>()({
      ...spec,
      logName: (input) => input.name,
      nameField: "name",
      nameOf: (row) => row.name,
    });
