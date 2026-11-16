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
  sqlCommas,
  sqlJoin,
  sqlList,
  sqlLiteral,
  sqlName,
  typedSql,
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
  typedSql(statement);

/** A column that code over any table names by text. A read of one known
 *  table takes its columns from the node of the table instead. */
export const named = <Value extends InValue = InValue>(
  column: string,
): Expr<Value> => valued(sqlName(column));

/** Conditions that one operator cannot split: a comparison, a test, a call.
 *  They join with AND or OR without brackets. */
const wholeConditions = new WeakSet<SqlStatement>();

/** The conditions that each AND joins, so an AND inside an AND reads as one
 *  list. */
const joinedByAnd = new WeakMap<SqlStatement, readonly Expr<boolean>[]>();

/** SQL that no row can pass: a condition, or a read with such a condition. A
 *  runner can answer the read with no rows and skip the database. */
const passedByNoRow = new WeakSet<SqlStatement>();

/** Name SQL as one condition that AND and OR cannot split: a comparison, a
 *  test, a call. A condition with a bare AND or OR in it is not whole. */
export const wholeCondition = (statement: SqlStatement): Expr<boolean> => {
  wholeConditions.add(statement);
  return valued(statement);
};

/** Mark SQL that no row can pass. */
export const matchingNothing = <Statement extends SqlStatement>(
  statement: Statement,
): Statement => {
  passedByNoRow.add(statement);
  return statement;
};

const ALWAYS = wholeCondition(sql`1`);
const NEVER = matchingNothing(wholeCondition(sql`0`));

/** Whether no row can pass the condition or the read. Only SQL from this
 *  module and from the builder carries the mark. */
export const matchesNothing = (statement: SqlStatement | boolean): boolean =>
  statement === false || (statement !== true && passedByNoRow.has(statement));

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

/** One condition out of several. */
type Joiner = (...conditions: readonly Condition[]) => Expr<boolean>;

/** Every condition holds. With no condition, every row passes. */
export const and: Joiner = (...conditions) => {
  const needed = conditions
    .filter((condition) => condition !== true)
    .map(asExpr)
    .flatMap((condition) => joinedByAnd.get(condition) ?? [condition]);
  if (needed.length === 0) return ALWAYS;
  const all = joinedBy(needed, sql` AND `);
  if (needed.length > 1) joinedByAnd.set(all, needed);
  return needed.some(matchesNothing) ? matchingNothing(all) : all;
};

/** The test of a value that the caller gave. Where the caller gave no value,
 *  the read keeps every row. */
export const given = <Value>(
  value: Value | undefined,
  test: (value: Value) => Condition,
): Condition => (value === undefined ? true : test(value));

/** The ` WHERE …` tail of a statement written by hand. It is empty where no
 *  condition narrows the rows. */
export const whereTail = (conditions: readonly Condition[]): SqlStatement => {
  const needed = conditions.filter((condition) => condition !== true);
  return needed.length === 0 ? sql`` : sql` WHERE ${and(...needed)}`;
};

/** Some condition holds. With no condition, no row passes. */
export const or: Joiner = (...conditions) => {
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

/** A test of a value against an expression of its type, or a value to bind. */
type Comparison = <Value extends Comparable | null>(
  left: Expr<Value>,
  right: Operand<NoInfer<Value>> | Expr<NoInfer<Value> | null>,
) => Expr<boolean>;

const comparison =
  (operator: SqlStatement): Comparison =>
  (left, right) =>
    wholeCondition(sql`${left} ${operator} ${right}`);

/** A comparison that asks a null on the right with `nullTest`, because
 *  `column = NULL` is never true. */
const nullAware =
  (operator: SqlStatement, nullTest: SqlStatement): Comparison =>
  (left, right) =>
    right === null
      ? wholeCondition(sql`${left} ${nullTest}`)
      : comparison(operator)(left, right);

/** The two sides are equal. A null on the right asks whether the column holds
 *  nothing. */
export const equal = nullAware(sql`=`, sql`IS NULL`);

/** The two sides differ. A null on the right asks whether the column holds a
 *  value. */
export const notEqual = nullAware(sql`!=`, sql`IS NOT NULL`);

/** The left side is below the right side. */
export const lessThan = comparison(sql`<`);

/** The left side is above the right side. */
export const greaterThan = comparison(sql`>`);

/** The left side is the right side or below it. */
export const atMost = comparison(sql`<=`);

/** The left side is the right side or above it. */
export const atLeast = comparison(sql`>=`);

/** The values a column can be one of. A null is never one of them. */
type Listed<Value> = readonly NonNullable<NoInfer<Value>>[];

/** The value is one of `values`. With no value, no row passes. `IN ()` is not
 *  valid SQL, so the empty list is written `IN (NULL)`. */
export const among = <Value extends Comparable | null>(
  value: Expr<Value>,
  values: Listed<Value>,
): Expr<boolean> =>
  values.length === 0
    ? matchingNothing(wholeCondition(sql`${value} IN (NULL)`))
    : wholeCondition(sql`${value} IN (${sqlList(values)})`);

/** One condition for each named column. A list means "is one of these". Any
 *  other value means "equals this", and a null asks for a column that holds
 *  nothing. */
export const matching = (
  columnOf: (name: string) => Expr<InValue>,
  match: Readonly<Record<string, unknown>>,
): Expr<boolean>[] =>
  Object.entries(match).map(([name, wanted]) =>
    Array.isArray(wanted)
      ? among(columnOf(name), wanted)
      : equal(columnOf(name), wanted as InValue),
  );

/** The value is one of these constants, each written into the SQL text. The
 *  list comes from the code, never from a request. */
export const amongConstants = <Value extends string | number | null>(
  value: Expr<Value>,
  constants: Listed<Value>,
): Expr<boolean> =>
  wholeCondition(sql`${value} IN (${sqlCommas(constants.map(sqlLiteral))})`);

/** The text matches the GLOB pattern. The pattern is a constant of the code,
 *  written into the SQL text. */
export const matchesGlob = (
  value: Expr<string | null>,
  pattern: string,
): Expr<boolean> => wholeCondition(sql`${value} GLOB ${sqlLiteral(pattern)}`);

declare const ONE_COLUMN: unique symbol;

/** A read of one unnamed column: the body of an `IN (…)`. */
export type ValuesStatement<Value> = SqlStatement & {
  readonly [ONE_COLUMN]: Value;
};

/** The value is one that a read written by hand gives. The read names one
 *  column. */
export const inStatement = (
  value: Expr<unknown>,
  rows: SqlStatement,
): Expr<boolean> => wholeCondition(sql`${value} IN (${rows})`);

/** A test of a value against the one column of a read. */
type RowsTest = <Value>(
  value: Expr<Value>,
  rows: ValuesStatement<NoInfer<Value>>,
) => Expr<boolean>;

/** The value is one that the read gives. */
export const inQuery: RowsTest = inStatement;

/** The value is none that the read gives. */
export const notInQuery: RowsTest = (value, rows) =>
  not(inStatement(value, rows));

/** A constant written into the SQL text. A partial index matches a query only
 *  when the query names the constant of the index as text. */
export const literal = <Value extends string | number>(
  value: Value,
): Expr<Value> => valued(sqlLiteral(value));

/** A whole number that SQLite counted or added. */
export type Counted = number | bigint;

/** The total of the value over the rows the read keeps. Null with no row. */
export const sum = (value: Expr<number | null>): Expr<Counted | null> =>
  valued(sql`SUM(${value})`);

/** A total that reads zero where no row adds to it. */
export const orZero = (value: Expr<Counted | null>): Expr<Counted> =>
  coalesce(value, literal(0));

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
export const when = <Value extends Comparable | null>(
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

/** The value, or `fallback` where the value is null. */
export const coalesce = <Value extends InValue>(
  value: Expr<Value | null>,
  fallback: Operand<NoInfer<Value>>,
): Expr<Value> => valued(sql`COALESCE(${value}, ${fallback})`);

/** The text matches the LIKE pattern. `%` stands for any run of letters and
 *  `_` for one letter. */
export const like = (
  value: Expr<string | null>,
  pattern: Operand<string>,
): Expr<boolean> => wholeCondition(sql`${value} LIKE ${pattern}`);
