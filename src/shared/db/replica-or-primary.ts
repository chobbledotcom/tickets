/**
 * One read in two versions: on a replica, and on the primary. A page read
 * can use a replica. A write that reads its own rows back uses the primary,
 * because a replica can lag behind the write.
 */

import { queryAllPrimary } from "#db/client.ts";
import { readRows } from "#db/read.ts";
import type { Read } from "#db/sql.ts";

/** A read of every row that a statement gives. */
export type RowsReader = <Row>(read: Read<Row>) => Promise<Row[]>;

/** The read that `build` makes, on a replica and on the primary. */
export const onReplicaAndPrimary = <Reader>(
  build: (readAll: RowsReader) => Reader,
): { onPrimary: Reader; onReplica: Reader } => ({
  onPrimary: build(queryAllPrimary),
  onReplica: build(readRows),
});
