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
import { inPlaceholders } from "#shared/db/client.ts";

/** One filter clause and the arguments that fill its placeholders.
 * `matchesNothing` marks a clause that no row can ever pass, so a reader can
 * skip the round-trip entirely — see {@link matchesNoRows}. */
export type WhereClause = {
  clause: string;
  args: InValue[];
  matchesNothing?: true;
};

/**
 * Keep rows whose `column` is one of `values` — no clause at all when the
 * caller did not ask for this filter.
 *
 * An empty set matches nothing. It emits `IN (NULL)` (always NULL, so no row
 * passes) rather than the syntactically invalid `IN ()`, so the builder still
 * produces valid SQL even if a caller doesn't prefilter an empty list.
 */
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

/**
 * Keep rows whose `column` equals `value` — no clause at all when the caller
 * passed nothing to match on.
 *
 * Only `undefined` means "don't filter on this". SQL NULL is a value, not an
 * absence, and `column = NULL` is never true, so passing it would quietly widen
 * a read to every row. The type rules it out and the guard catches a caller who
 * gets there past the types; a read that wants NULL writes its own `IS NULL`.
 */
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

/** Whether these clauses can never match a row, so the query is not worth
 * running. A filter asking for none of something — no ids, no keys — is the
 * ordinary way this happens. */
export const matchesNoRows = (parts: readonly WhereClause[]): boolean =>
  parts.some((part) => part.matchesNothing);

/** The ` WHERE …` tail for a set of clauses, or nothing when there are none. */
export const whereSql = (parts: readonly WhereClause[]): string =>
  parts.length === 0
    ? ""
    : ` WHERE ${parts.map((part) => part.clause).join(" AND ")}`;

/** Every clause's arguments, in clause order. */
export const clauseArgs = (parts: readonly WhereClause[]): InValue[] =>
  parts.flatMap((part) => part.args);

/** The ` ORDER BY …` tail for a named order, or nothing when the caller does
 * not care how the rows come back. */
export const orderSql = <Order extends string>(
  orders: Record<Order, string>,
  order: Order | undefined,
): string => (order === undefined ? "" : ` ORDER BY ${orders[order]}`);
