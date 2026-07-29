/**
 * The shared parts of a declarative read: filter clauses that carry their own
 * bound arguments, and the tail SQL built from them.
 *
 * The attendee and listing readers both let a caller declare WHICH rows it
 * wants instead of writing SQL. Both turn that declaration into a list of
 * clauses, join them with `AND`, and collect the arguments in clause order.
 * Keeping each clause and its arguments together is the point: it is what makes
 * the two orders impossible to drift apart.
 */

import type { InValue } from "@libsql/client";
import { inPlaceholders, type SqlStatement } from "#shared/db/client.ts";

/** One filter clause and the arguments that fill its placeholders.
 * `matchesNothing` marks a clause that no row can ever pass, so a reader can
 * skip the round-trip entirely — see {@link matchesNoRows}. */
export type WhereClause = {
  clause: string;
  args: InValue[];
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
      ? { args: [], clause: `${column} IN (NULL)`, matchesNothing: true }
      : {
          args: [...values],
          clause: `${column} IN (${inPlaceholders(values)})`,
        },
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
    : [{ args: [value], clause: `${column} = ?` }];
};

/** Whether these clauses can never match a row — the ordinary cause being a
 * filter asking for none of something. */
const matchesNoRows = (parts: readonly WhereClause[]): boolean =>
  parts.some((part) => part.matchesNothing);

/** Run a read unless its clauses can match no row — asking for none of
 * something is already answered, so it costs no round trip. */
export const rowsUnlessNoneMatch = <Row>(
  where: readonly WhereClause[],
  run: () => Promise<Row[]>,
): Promise<Row[]> => (matchesNoRows(where) ? Promise.resolve([]) : run());

/** The ` WHERE …` tail for a set of clauses, or nothing when there are none. */
export const whereSql = (parts: readonly WhereClause[]): string =>
  parts.length === 0
    ? ""
    : ` WHERE ${parts.map((part) => part.clause).join(" AND ")}`;

/** Every clause's arguments, in clause order. */
export const clauseArgs = (parts: readonly WhereClause[]): InValue[] =>
  parts.flatMap((part) => part.args);

/**
 * Everything after a read's columns and table: which rows, in what order, how
 * many — with the values that fill them, in the order the placeholders appear.
 * `order` is a constant belonging to the read, never caller input, so unlike a
 * filter it carries no values of its own.
 */
export const queryTail = (
  where: readonly WhereClause[],
  options: { order?: string; limit?: number } = {},
): SqlStatement => ({
  args: [
    ...clauseArgs(where),
    ...(options.limit === undefined ? [] : [options.limit]),
  ],
  sql:
    whereSql(where) +
    (options.order === undefined ? "" : ` ORDER BY ${options.order}`) +
    (options.limit === undefined ? "" : " LIMIT ?"),
});

/** The ` ORDER BY …` tail for a named order, or nothing when the caller does
 * not care how the rows come back. */
export const orderSql = <Order extends string>(
  orders: Record<Order, string>,
  order: Order | undefined,
): string => (order === undefined ? "" : ` ORDER BY ${orders[order]}`);
