/**
 * Run a read from the builder in `#db/select/query.ts`. A read whose
 * conditions no row can pass costs no round trip.
 */

import { queryAll } from "#db/client.ts";
import { matchesNothing } from "#db/select/expression.ts";
import type { Query } from "#db/select/shape.ts";
import type { Read } from "#db/sql.ts";

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
