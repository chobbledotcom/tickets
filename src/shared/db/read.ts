/**
 * Run a read from the builder in `#db/select/query.ts`. A read whose
 * conditions no row can pass costs no round trip.
 */

import {
  type BatchExecutor,
  queryAll,
  queryBatch,
  queryBatchPrimary,
  resultRows,
} from "#db/client.ts";
import { matchesNothing } from "#db/select/expression.ts";
import type { Query } from "#db/select/shape.ts";
import type { Read, RowsStatement, SqlStatement } from "#db/sql.ts";

/** Every row that the read keeps. */
export const readRows = <Row>(read: Read<Row>): Promise<Row[]> =>
  matchesNothing(read) ? Promise.resolve([]) : queryAll<Row>(read);

/** The first row that the read keeps, or null when it keeps none. Limit the
 *  read to one row where it can keep more. */
export const readOneRow = async <Row>(read: Read<Row>): Promise<Row | null> =>
  (await readRows<Row>(read))[0] ?? null;

/** Whether the read has a row. */
export const readExists = async (
  query: Query<unknown, never>,
): Promise<boolean> => (await readOneRow(query.probe())) !== null;

/** The rows of each read of a batch, in the order of the reads. A statement
 *  that names no row gives rows of no known type. */
type RowsOfEach<Reads extends readonly SqlStatement[]> = {
  -readonly [Index in keyof Reads]: Reads[Index] extends RowsStatement<
    infer Row
  >
    ? Row[]
    : unknown[];
};

const batchReader =
  (run: BatchExecutor) =>
  async <const Reads extends readonly SqlStatement[]>(
    reads: Reads,
  ): Promise<RowsOfEach<Reads>> =>
    (await run([...reads])).map((result) =>
      resultRows(result),
    ) as RowsOfEach<Reads>;

/** Every read of a batch in one round trip. Each read keeps its place, so a
 *  read that no row can pass still runs. */
export const readBatch = batchReader(queryBatch);

/** {@link readBatch} for a caller that must read its own writes. */
export const readBatchPrimary = batchReader(queryBatchPrimary);
