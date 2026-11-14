/**
 * One shape for a read, and the two things you can do with it: turn it into a
 * statement, or run it.
 *
 * A read is one sentence — these columns, from here, keeping these rows, in
 * this order, at most this many. A reader says the sentence; this assembles it,
 * and skips the database when the filter cannot match a row.
 *
 * A read that joins or carries a subquery says so in its `from` — it is still
 * one sentence, just a longer one.
 */

import { queryAll } from "#db/client.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import {
  rowsUnlessNoneMatch,
  type WhereClause,
  whereSql,
} from "#db/where-clauses.ts";

/** A read, said rather than written. */
export type Read = {
  /** The SELECT column list, without the keyword. */
  columns: SqlStatement;
  /** The FROM body, without the keyword — a table name, or a whole join. */
  from: SqlStatement;
  /** Which rows to keep. Absent or empty keeps every row. */
  where?: readonly WhereClause[] | undefined;
  /** A `GROUP BY` body without the keyword, for a read that folds rows. */
  groupBy?: SqlStatement | undefined;
  /** An `ORDER BY` body without the keyword. Omit when the caller does not care
   * how the rows come back. */
  order?: SqlStatement | undefined;
  /** A row cap. Omit for no limit. */
  limit?: number | undefined;
};

const tail = (
  part: SqlStatement,
  body: SqlStatement | undefined,
): SqlStatement => (body === undefined ? sql`` : sql`${part}${body}`);

/** The statement a read becomes. For a caller that must embed the read in a
 * batch rather than run it. */
export const readStatement = (read: Read): SqlStatement =>
  sql`SELECT ${read.columns} FROM ${read.from}${whereSql(
    read.where ?? [],
  )}${tail(sql` GROUP BY `, read.groupBy)}${tail(
    sql` ORDER BY `,
    read.order,
  )}${read.limit === undefined ? sql`` : sql` LIMIT ${read.limit}`}`;

/** Run a read and return every matching row. A filter that cannot match
 * anything is already answered, so it costs no round trip. */
export const readRows = <Row>(read: Read): Promise<Row[]> =>
  rowsUnlessNoneMatch(read.where ?? [], () =>
    queryAll<Row>(readStatement(read)),
  );

/** Run a read for at most one row. Capping the read is the whole difference
 * from {@link readRows} — there is no second path for a single row. */
export const readOneRow = async <Row>(read: Read): Promise<Row | null> =>
  (await readRows<Row>({ ...read, limit: 1 }))[0] ?? null;

/** The `ORDER BY` body for a named order, or nothing when the caller does not
 * care. Named so a caller cannot hand-roll a stray order of its own. */
const namedOrder = <Order extends string>(
  orders: Record<Order, SqlStatement>,
  order: Order | undefined,
): SqlStatement | undefined =>
  order === undefined ? undefined : orders[order];

/** What a reader can be asked for: which rows, and which of its named orders
 * they come back in. */
export type NamedOrderQuery<Order extends string> = { order?: Order };

/** The two things every reader offers: the statement, for a caller that must
 * embed the read in a batch, and the rows, for everyone else. The row shape is
 * the caller's to name, as it is with `queryAll`. */
export type Reader<Query> = {
  statement: (query: Query) => SqlStatement;
  rows: <Row>(query: Query) => Promise<Row[]>;
};

/**
 * Build a reader from its orders and one function saying what the read is.
 * A collection's reader differs from another's only in those two things — the
 * turning of a said read into a statement, and of a statement into rows, is
 * the same work every time, so it is done here once.
 */
export const defineReader = <
  Order extends string,
  Query extends NamedOrderQuery<Order>,
>(
  orders: Record<Order, SqlStatement>,
  readFor: (query: Query) => Omit<Read, "order">,
): Reader<Query> => {
  const read = (query: Query): Read => ({
    ...readFor(query),
    order: namedOrder(orders, query.order),
  });
  return {
    rows: (query) => readRows(read(query)),
    statement: (query) => readStatement(read(query)),
  };
};
