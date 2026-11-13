/**
 * The common declaration of a record whose row and input both carry a `name`.
 * The display name, the log name, and the confirmation column are the same
 * fact on every such record. They are filled here.
 */

import {
  type AdminRecord,
  defineRecord,
  type RecordRule,
  type RecordShape,
  type RecordSpec,
} from "#shared/rest/record.ts";
import { okResult } from "#shared/result.ts";

export const defineNamedRowRecord = <
  Shape extends RecordShape & {
    row: { id: number; name: string };
    input: { name: string };
  },
>(
  spec: Omit<RecordSpec<Shape>, "logName" | "nameField" | "nameOf" | "rule"> & {
    /** The one write rule. A record with no domain rule passes nothing and
     *  gets its input back unchanged. */
    rule?: RecordRule<Shape["input"], Shape["row"]>;
  },
): AdminRecord<Shape> =>
  defineRecord<Shape>({
    ...spec,
    logName: (input) => input.name,
    nameField: "name",
    nameOf: (row) => row.name,
    rule: spec.rule ?? ((input) => okResult(input)),
  });
