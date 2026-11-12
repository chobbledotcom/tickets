/**
 * The common declaration of a record whose row and input both carry a `name`.
 * The display name, the log name, and the confirmation column are the same
 * fact on every such record. They are filled here.
 */

import {
  defineRecord,
  type RecordRule,
  type RecordSpec,
} from "#shared/rest/record.ts";
import { okResult } from "#shared/result.ts";

/** A named record's declaration, before the three name facts are filled. */
type NamedRecordSpec<
  Row extends { id: number; name: string },
  Input extends { name: string },
  FullRow extends Row,
  State,
  ListRow,
> = Omit<
  RecordSpec<Row, Input, FullRow, State, ListRow>,
  "logName" | "nameField" | "nameOf" | "rule"
> & {
  /** The one write rule. A record with no domain rule passes nothing and gets
   *  its input back unchanged. */
  rule?: RecordRule<Input, Row>;
};

export const defineNamedRowRecord = <
  Row extends { id: number; name: string },
  Input extends { name: string },
  FullRow extends Row = Row,
  State = never,
  ListRow = FullRow,
>(
  spec: NamedRecordSpec<Row, Input, FullRow, State, ListRow>,
) =>
  defineRecord<Row, Input, FullRow, State, ListRow>({
    ...spec,
    logName: (input) => input.name,
    nameField: "name",
    nameOf: (row) => row.name,
    rule: spec.rule ?? ((input) => okResult(input)),
  });
