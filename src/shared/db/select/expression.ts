// effects: pure
/**
 * Typed SQL expressions: a column, a worked-out value, or a condition.
 *
 * An expression is a statement that also names the type of its value. It goes
 * into any `sql` template as it is, so a read from the builder and SQL written
 * by hand can share one statement.
 */

import type { InValue } from "@libsql/client";
import {
  type SqlStatement,
  sql,
  sqlJoin,
  sqlList,
  sqlLiteral,
} from "#db/sql.ts";

declare const VALUE: unique symbol;

/** SQL whose value has the type `Value`. */
export type Expr<Value> = SqlStatement & { readonly [VALUE]: Value };

/** A value that SQLite can compare with a column. */
type Comparable = Exclude<InValue, null>;

/** The other side of a comparison: an expression of the same type, or a value
 *  to bind. */
export type Operand<Value> = Expr<Value> | Extract<Value, InValue>;

/** A condition: an expression, or a fact known before the read such as "the
 *  caller asked for active rows only". */
export type Condition = Expr<boolean> | boolean;

/** Name the type of the value that hand-written SQL gives. */
export const valued = <Value>(statement: SqlStatement): Expr<Value> =>
  statement as Expr<Value>;

/** Conditions that one operator cannot split: a comparison, a test, a call.
 *  They join with AND or OR without brackets. */
const wholeConditions = new WeakSet<SqlStatement>();

/** Conditions that no row can pass, so a read can skip the database. */
const emptyConditions = new WeakSet<SqlStatement>();

/** Name SQL as one condition that AND and OR cannot split: a comparison, a
 *  test, a call. A condition with a bare AND or OR in it is not whole. */
export const wholeCondition = (statement: SqlStatement): Expr<boolean> => {
  wholeConditions.add(statement);
  return valued(statement);
};

const matchingNothing = (condition: Expr<boolean>): Expr<boolean> => {
  emptyConditions.add(condition);
  return condition;
};

const ALWAYS = wholeCondition(sql`1`);
const NEVER = matchingNothing(wholeCondition(sql`0`));

/** Whether no row can pass the condition. */
export const matchesNothing = (condition: Condition): boolean =>
  condition === false || (condition !== true && emptyConditions.has(condition));

const asExpr = (condition: Condition): Expr<boolean> => {
  if (condition === true) return ALWAYS;
  if (condition === false) return NEVER;
  return condition;
};

const bracketed = (condition: Expr<boolean>): SqlStatement =>
  wholeConditions.has(condition) ? condition : sql`(${condition})`;

const joinedBy = (
  conditions: readonly Expr<boolean>[],
  operator: SqlStatement,
): Expr<boolean> =>
  conditions.length === 1
    ? conditions[0]!
    : valued(sqlJoin(conditions.map(bracketed), operator));

/** Every condition holds. With no condition, every row passes. */
export const and = (...conditions: readonly Condition[]): Expr<boolean> => {
  const needed = conditions.filter((condition) => condition !== true);
  if (needed.length === 0) return ALWAYS;
  const all = joinedBy(needed.map(asExpr), sql` AND `);
  return needed.some(matchesNothing) ? matchingNothing(all) : all;
};

/** Some condition holds. With no condition, no row passes. */
export const or = (...conditions: readonly Condition[]): Expr<boolean> => {
  const possible = conditions.filter((condition) => condition !== false);
  if (possible.length === 0) return NEVER;
  const any = wholeCondition(
    sql`(${joinedBy(possible.map(asExpr), sql` OR `)})`,
  );
  return possible.every(matchesNothing) ? matchingNothing(any) : any;
};

/** The condition does not hold. */
export const not = (condition: Condition): Expr<boolean> =>
  wholeCondition(sql`NOT ${bracketed(asExpr(condition))}`);

const comparison =
  (operator: SqlStatement) =>
  <Value extends Comparable | null>(
    left: Expr<Value>,
    right: Operand<NoInfer<Value>>,
  ): Expr<boolean> =>
    wholeCondition(sql`${left} ${operator} ${right}`);

const equalTo = comparison(sql`=`);
const differentFrom = comparison(sql`!=`);

/** The two sides are equal. A null on the right asks whether the column holds
 *  nothing, because `column = NULL` is never true. */
export const equal = <Value extends Comparable | null>(
  left: Expr<Value>,
  right: Operand<NoInfer<Value>>,
): Expr<boolean> =>
  right === null ? wholeCondition(sql`${left} IS NULL`) : equalTo(left, right);

/** The two sides differ. A null on the right asks whether the column holds a
 *  value. */
export const notEqual = <Value extends Comparable | null>(
  left: Expr<Value>,
  right: Operand<NoInfer<Value>>,
): Expr<boolean> =>
  right === null
    ? wholeCondition(sql`${left} IS NOT NULL`)
    : differentFrom(left, right);

/** The left side is below the right side. */
export const lessThan = comparison(sql`<`);

/** The left side is above the right side. */
export const greaterThan = comparison(sql`>`);

/** The left side is the right side or below it. */
export const atMost = comparison(sql`<=`);

/** The left side is the right side or above it. */
export const atLeast = comparison(sql`>=`);

/** The value is one of `values`. With no value, no row passes. `IN ()` is not
 *  valid SQL, so the empty list is written `IN (NULL)`. */
export const among = <Value extends Comparable | null>(
  value: Expr<Value>,
  values: readonly Extract<NoInfer<Value>, Comparable>[],
): Expr<boolean> =>
  values.length === 0
    ? matchingNothing(wholeCondition(sql`${value} IN (NULL)`))
    : wholeCondition(sql`${value} IN (${sqlList(values)})`);

/** A constant written into the SQL text. A partial index matches a query only
 *  when the query names the constant of the index as text. */
export const literal = <Value extends string | number>(
  value: Value,
): Expr<Value> => valued(sqlLiteral(value));

/** The value, or `fallback` where the value is null. */
export const coalesce = <Value extends Comparable>(
  value: Expr<Value | null>,
  fallback: Operand<NoInfer<Value>>,
): Expr<Value> => valued(sql`COALESCE(${value}, ${fallback})`);

/** A whole number that SQLite counted or added. */
export type Counted = number | bigint;

/** How many rows the read keeps. */
export const count = (): Expr<Counted> => valued(sql`COUNT(*)`);

/** The total of the value over the rows the read keeps. Null with no row. */
export const sum = (value: Expr<number | null>): Expr<Counted | null> =>
  valued(sql`SUM(${value})`);

/** A total that reads zero where no row adds to it. */
export const orZero = (value: Expr<Counted | null>): Expr<Counted> =>
  valued(sql`COALESCE(${value}, 0)`);

const arithmetic =
  (operator: SqlStatement) =>
  <Value extends Counted | null>(
    left: Expr<Value>,
    right: Operand<Counted>,
  ): Expr<Value> =>
    valued(sql`(${left} ${operator} ${right})`);

/** The left side plus the right side. Null stays null. */
export const plus = arithmetic(sql`+`);

/** The left side less the right side. Null stays null. */
export const minus = arithmetic(sql`-`);

/** One branch of {@link when}: a condition, and the value where it holds. */
type Branch<Value> = readonly [Condition, Operand<Value>];

/** The value of the first branch whose condition holds, else `otherwise`. */
export const when = <Value extends Comparable>(
  branches: readonly Branch<Value>[],
  otherwise: Operand<NoInfer<Value>>,
): Expr<Value> =>
  valued(
    sql`CASE ${sqlJoin(
      branches.map(
        ([condition, value]) => sql`WHEN ${asExpr(condition)} THEN ${value}`,
      ),
      sql` `,
    )} ELSE ${otherwise} END`,
  );

/** The order of a value, largest first. */
export const desc = (value: Expr<unknown>): SqlStatement => sql`${value} DESC`;
