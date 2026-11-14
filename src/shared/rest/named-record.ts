/**
 * The common declaration of a record whose row and input both carry a `name`.
 * The display name, the log name, and the confirmation column are the same
 * fact on every such record. They are filled here.
 */

import { catalogNameLengthError } from "#db/name-registry.ts";
import {
  defineRecord,
  type RecordDefiner,
  type RecordShape,
} from "#shared/rest/record.ts";
import { errorResult, type Result } from "#shared/result.ts";

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

/** Put the name limit before a record rule. A name past the limit of a text
 *  box gets the message of the form, so the form can save the record again. */
export const withNameLimit =
  <Input extends { name: string }>(rule: (input: Input) => Result<Input>) =>
  (input: Input): Result<Input> => {
    const nameLengthError = catalogNameLengthError(input.name);
    return nameLengthError ? errorResult(nameLengthError) : rule(input);
  };
