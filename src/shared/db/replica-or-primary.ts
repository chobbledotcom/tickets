/**
 * One read in two versions: on a replica, and on the primary. A page read
 * can use a replica. A write that reads its own rows back uses the primary,
 * because a replica can lag behind the write.
 */

import { queryAllPrimary } from "#db/client.ts";
import { readRows } from "#db/read.ts";
import type { Read } from "#db/sql.ts";

/** A read of every row that a statement gives. */
type RowsReader = <Row>(read: Read<Row>) => Promise<Row[]>;

/** The read that `read` makes for an input, with its rows shaped by `shape`,
 *  on a replica and on the primary. */
export const onReplicaAndPrimary = <Input, Row, Answer>(
  read: (input: Input) => Read<Row>,
  shape: (rows: Row[]) => Answer,
) => {
  const readOn =
    (readAll: RowsReader) =>
    async (input: Input): Promise<Answer> =>
      shape(await readAll(read(input)));
  return { onPrimary: readOn(queryAllPrimary), onReplica: readOn(readRows) };
};
