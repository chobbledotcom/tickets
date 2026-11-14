/**
 * The shared parts of a declarative read: filter clauses that carry their own
 * bound values, and the tail SQL built from them.
 *
 * The attendee and listing readers both let a caller declare WHICH rows it
 * wants instead of writing SQL. Both turn that declaration into a list of
 * clauses and join them with `AND`.
 */

import type { InValue } from "@libsql/client";
import { type SqlStatement, sql, sqlJoin, sqlList, sqlName } from "#db/sql.ts";

/** One filter clause, with the values it binds.
 * `matchesNothing` marks a clause that no row can ever pass, so a reader can
 * skip the round-trip entirely — see {@link matchesNoRows}. */
export type WhereClause = {
  clause: SqlStatement;
  matchesNothing?: true;
};

/** Keep rows whose `column` is one of `values`; absent means "don't filter on
 * this". An empty set matches nothing, spelled `IN (NULL)` because `IN ()` is
 * SQL no database accepts. */
export const inList = (
  column: string,
  values: readonly InValue[] | undefined,
): WhereClause[] => {
  if (values === undefined) return [];
  return [
    values.length === 0
      ? { clause: sql`${sqlName(column)} IN (NULL)`, matchesNothing: true }
      : { clause: sql`${sqlName(column)} IN (${sqlList(values)})` },
  ];
};

/** Keep rows whose `column` equals `value`; absent means "don't filter on this".
 * NULL is refused rather than accepted: `column = NULL` is never true, so taking
 * it would quietly widen a read to every row. A read wanting NULL writes its own
 * `IS NULL`. */
export const equals = (
  column: string,
  value: Exclude<InValue, null> | undefined,
): WhereClause[] => {
  if (value === null) {
    throw new Error(
      `Cannot filter ${column} against NULL: pass undefined for "no filter", or write an IS NULL clause`,
    );
  }
  return value === undefined
    ? []
    : [{ clause: sql`${sqlName(column)} = ${value}` }];
};

/** Keep rows whose `column` is (or is not) among the ones another query names.
 * The subquery brings its own values. */
const bySubquery =
  (keyword: SqlStatement) =>
  (column: string, subquery: SqlStatement): WhereClause[] => [
    { clause: sql`${sqlName(column)} ${keyword} (${subquery})` },
  ];

/** Keep or drop rows another query names. */
type SubqueryFilter = (column: string, subquery: SqlStatement) => WhereClause[];

/** Keep rows the subquery names — "pick some rows, then read everything that
 * hangs off them". */
export const inSubquery: SubqueryFilter = bySubquery(sql`IN`);

/** Keep rows the subquery does NOT name. */
export const notInSubquery: SubqueryFilter = bySubquery(sql`NOT IN`);

/** Whether these clauses can never match a row — the ordinary cause being a
 * filter asking for none of something. A reader that bundles several queries
 * asks this directly, to leave the already-answered ones out of the bundle. */
export const matchesNoRows = (parts: readonly WhereClause[]): boolean =>
  parts.some((part) => part.matchesNothing);

/** Run a read unless its clauses can match no row — asking for none of
 * something is already answered, so it costs no round trip. */
export const rowsUnlessNoneMatch = <Row>(
  where: readonly WhereClause[],
  run: () => Promise<Row[]>,
): Promise<Row[]> => (matchesNoRows(where) ? Promise.resolve([]) : run());

/** The ` WHERE …` tail for a set of clauses, or nothing when there are none. */
export const whereSql = (parts: readonly WhereClause[]): SqlStatement =>
  parts.length === 0
    ? sql``
    : sql` WHERE ${sqlJoin(
        parts.map((part) => part.clause),
        sql` AND `,
      )}`;

/** A delete over whichever rows the clauses it is given select. */
type DeleteFromTable = (where: readonly WhereClause[]) => SqlStatement;

/** A delete over the rows some clauses select. */
export const deleteWhere =
  (table: string): DeleteFromTable =>
  (where) =>
    sql`DELETE FROM ${sqlName(table)}${whereSql(where)}`;
