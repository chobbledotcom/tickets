/**
 * Run a read from the builder in `#db/select/query.ts`. A read whose
 * conditions no row can pass costs no round trip.
 */

import { queryAll } from "#db/client.ts";
import { readsNothing } from "#db/select/query.ts";
import type { Read } from "#db/sql.ts";

/** Every row that the read keeps. */
export const readRows = <Row>(read: Read<Row>): Promise<Row[]> =>
  readsNothing(read) ? Promise.resolve([]) : queryAll<Row>(read);

/** The first row that the read keeps, or null when it keeps none. Limit the
 *  read to one row where it can keep more. */
export const readOneRow = async <Row>(read: Read<Row>): Promise<Row | null> =>
  (await readRows<Row>(read))[0] ?? null;
