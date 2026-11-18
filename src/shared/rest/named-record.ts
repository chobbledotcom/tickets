/**
 * The common declaration of a record whose row and input both carry a `name`.
 * The display name, the log name, and the confirmation column are the same
 * fact on every such record. They are filled here, with the name limit that
 * no named record can omit.
 */

import { nameLengthError } from "#shared/name-limit.ts";
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
    "inputCheck" | "logName" | "nameField" | "nameOf"
  > =>
  (spec) =>
    defineRecord<Shape>()({
      ...spec,
      // A name past the limit of a text box gets the shared name message, so
      // the form can save the record again.
      inputCheck: (input) => nameLengthError(input.name),
      logName: (input) => input.name,
      nameField: "name",
      nameOf: (row) => row.name,
    });
