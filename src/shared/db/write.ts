// effects: pure
/**
 * Writes over the declared tables, said as functions.
 *
 * `insertInto(table, rows)` adds rows. `update(table, changes)` and
 * `deleteFrom(table)` change the rows that their `where` keeps. A value is the
 * stored value of its column, or an expression of the same type, so a column
 * that does not exist or a value of the wrong type is a compile error. Each
 * write is a statement that runs alone, in a batch or in a transaction.
 */

import type { InValue } from "@libsql/client";
import {
  and,
  type Condition,
  type Expr,
  equal,
  matching,
  named,
  type Operand,
  valued,
  whereTail,
} from "#db/select/expression.ts";
import { tableNode } from "#db/select/query.ts";
import type { Matching, Node } from "#db/select/shape.ts";
import type {
  NewRowOf,
  RowOf,
  TableHandle,
  TableName,
} from "#db/select/tables.ts";
import {
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlCommas,
  sqlName,
  sqlNames,
  sqlRows,
} from "#db/sql.ts";

/** The name of a column of a table. */
export type ColumnName<Name extends TableName> = keyof RowOf<Name> & string;

/** A value to write to a column: its stored value, or SQL of that type. */
type Written<Value> = Operand<Value> | Expr<Value>;

/** The new values of some columns. A column that is left out keeps its value.
 *  An `undefined` value counts as left out. */
export type Changes<Name extends TableName> = {
  readonly [Column in ColumnName<Name>]?:
    | Written<RowOf<Name>[Column]>
    | undefined;
};

/** One new row: a value for every column that the database cannot fill. */
export type NewValues<Name extends TableName> = {
  readonly [Column in keyof NewRowOf<Name>]: Written<NewRowOf<Name>[Column]>;
};

/** One row, or several. A write of no row is not SQL, so the list holds one
 *  row at least. */
type OneOrMore<Row> = Row | readonly [Row, ...Row[]];

/** A write. `returning` gives the statement that also reads the named columns
 *  of each row that it wrote. */
export type Write<Name extends TableName> = SqlStatement & {
  readonly returning: <Column extends ColumnName<Name>>(
    ...columns: readonly [Column, ...Column[]]
  ) => RowsStatement<{ -readonly [Each in Column]: RowOf<Name>[Each] }>;
};

/** What an insert does with a row whose key is already stored. `nothing`
 *  keeps the stored row. `take` copies the named columns from the new row.
 *  `set` works out other changes from the stored row and the new one. The
 *  stored row changes only where `where` holds. */
export type Conflict<Name extends TableName> = Readonly<
  { on?: readonly ColumnName<Name>[] } & (
    | { nothing: true }
    | {
        take?: readonly ColumnName<Name>[];
        set?: (row: Node<Name>, excluded: Node<Name>) => Changes<Name>;
        where?: (row: Node<Name>, excluded: Node<Name>) => Condition;
      }
  )
>;

/** How an insert goes beyond plain new rows. */
export type InsertOptions<Name extends TableName> = Readonly<{
  /** SQLite's own answer to any broken rule: skip the row, or replace the
   *  stored row. */
  or?: "IGNORE" | "REPLACE";
  onConflict?: Conflict<Name>;
  /** Add the one row only where this holds. */
  when?: Condition;
}>;

/** The node of a table under its own name: the columns of a write. */
const nodeOfWrite = <Name extends TableName>(
  table: TableHandle<Name>,
): Node<Name> => tableNode(table, table.name);

/** The entries of `values` that hold a value. */
const given = (values: object): [string, unknown][] =>
  Object.entries(values).filter(([, value]) => value !== undefined);

/** One `column = value` for each change. */
const assignments = (changes: object): SqlStatement[] =>
  given(changes).map(
    ([column, value]) => sql`${sqlName(column)} = ${value as InValue}`,
  );

/** Give a statement its `returning` step. */
const writing = <Name extends TableName>(
  statement: SqlStatement,
): Write<Name> =>
  Object.defineProperty(statement, "returning", {
    value: (...columns: readonly string[]) =>
      sql`${statement} RETURNING ${sqlNames(columns)}`,
  }) as Write<Name>;

/** The `ON CONFLICT …` tail of an insert. */
const conflictTail = <Name extends TableName>(
  table: TableHandle<Name>,
  conflict: Conflict<Name>,
): SqlStatement => {
  const target =
    conflict.on === undefined ? sql`` : sql`(${sqlNames(conflict.on)})`;
  if ("nothing" in conflict) return sql` ON CONFLICT${target} DO NOTHING`;
  const row = nodeOfWrite(table);
  const excluded = tableNode(table, "excluded");
  const taken = (conflict.take ?? []).map(
    (column) =>
      sql`${sqlName(column)} = ${(excluded as Record<string, SqlStatement>)[column]!}`,
  );
  const changes = [
    ...taken,
    ...assignments(conflict.set?.(row, excluded) ?? {}),
  ];
  if (changes.length === 0) {
    throw new Error(`An upsert of ${table.name} names no column to change.`);
  }
  const guard =
    conflict.where === undefined
      ? sql``
      : whereTail([conflict.where(row, excluded)]);
  return sql` ON CONFLICT${target} DO UPDATE SET ${sqlCommas(changes)}${guard}`;
};

/** The column names of the rows, which every row must give alike. */
const columnsOfRows = (
  name: string,
  rows: readonly object[],
): readonly string[] => {
  const columns = given(rows[0]!).map(([column]) => column);
  const shape = columns.toSorted().join();
  for (const row of rows) {
    const own = given(row)
      .map(([column]) => column)
      .toSorted();
    if (own.join() !== shape) {
      throw new Error(`Each new row of ${name} must name the same columns.`);
    }
  }
  if (columns.length === 0) {
    throw new Error(`A new row of ${name} names no column.`);
  }
  return columns;
};

/** Add rows to `table`. */
export const insertInto = <Name extends TableName>(
  table: TableHandle<Name>,
  rows: OneOrMore<NewValues<Name>>,
  options: InsertOptions<Name> = {},
): Write<Name> => {
  const list: readonly object[] = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) {
    throw new Error(`An insert into ${table.name} has no row.`);
  }
  const columns = columnsOfRows(table.name, list);
  const values = list.map((row) =>
    columns.map(
      (column) => (row as Record<string, InValue | SqlStatement>)[column]!,
    ),
  );
  const or = options.or === undefined ? sql`` : sql` OR ${sqlName(options.or)}`;
  const source = sourceOf(values, options.when);
  const conflict =
    options.onConflict === undefined
      ? sql``
      : conflictTail(table, options.onConflict);
  return writing(
    sql`INSERT${or} INTO ${sqlName(table.name)} (${sqlNames(columns)}) ${source}${conflict}`,
  );
};

/** The insert of every row as a list for a batch: no statement when there is
 *  no row, else one statement. */
export const insertingAll = <Name extends TableName>(
  table: TableHandle<Name>,
  rows: readonly NewValues<Name>[],
  options: InsertOptions<Name> = {},
): Write<Name>[] =>
  rows.length === 0
    ? []
    : [insertInto(table, rows as readonly [NewValues<Name>], options)];

/** The VALUES of an insert, or the one row it adds only where `when` holds. */
const sourceOf = (
  values: readonly (readonly (InValue | SqlStatement)[])[],
  when: Condition | undefined,
): SqlStatement => {
  if (when === undefined) return sql`VALUES ${sqlRows(values)}`;
  if (values.length > 1) {
    throw new Error("A guarded insert adds one row.");
  }
  const row = sqlCommas(values[0]!.map((value) => sql`${value}`));
  return sql`SELECT ${row} WHERE ${and(when)}`;
};

/** Which rows a write changes: a match of the table's columns, or conditions
 *  built from its node. */
export type WriteWhere<Name extends TableName> =
  | Matching<Node<Name>>
  | ((row: Node<Name>) => Condition | readonly Condition[]);

/** The rows whose `column` holds `value`, for code over any table. A type
 *  parameter cannot name its columns in a match. */
export const rowsWith =
  <Name extends TableName>(
    table: TableHandle<Name>,
    column: ColumnName<Name>,
    value: InValue,
  ): WriteWhere<Name> =>
  () =>
    equal(named(`${table.name}.${column}`), value);

/** The conditions of a write. An empty match would change every row, which a
 *  write says with `everyRow` instead. */
const conditionsOf = <Name extends TableName>(
  table: TableHandle<Name>,
  where: WriteWhere<Name>,
): readonly Condition[] => {
  const row = nodeOfWrite(table);
  if (typeof where === "function") return [where(row)].flat();
  const conditions = matching(
    (column) => valued((row as Record<string, SqlStatement>)[column]!),
    { ...where },
  );
  if (conditions.length === 0) {
    throw new Error(
      `A write to ${table.name} matches every row. Say everyRow() for that.`,
    );
  }
  return conditions;
};

/** A write that waits for the rows it changes. */
type Scoped<Name extends TableName> = Readonly<{
  where: (where: WriteWhere<Name>) => Write<Name>;
  everyRow: () => Write<Name>;
}>;

const scoped = <Name extends TableName>(
  table: TableHandle<Name>,
  head: SqlStatement,
): Scoped<Name> => ({
  everyRow: () => writing(head),
  where: (where) =>
    writing(sql`${head}${whereTail(conditionsOf(table, where))}`),
});

/** Change some columns of the rows that `where` keeps. `changes` can work out
 *  a new value from the current row. */
export const update = <Name extends TableName>(
  table: TableHandle<Name>,
  changes: Changes<Name> | ((row: Node<Name>) => Changes<Name>),
): Scoped<Name> => {
  const set = assignments(
    typeof changes === "function" ? changes(nodeOfWrite(table)) : changes,
  );
  if (set.length === 0) {
    throw new Error(`An update of ${table.name} names no column to change.`);
  }
  return scoped(
    table,
    sql`UPDATE ${sqlName(table.name)} SET ${sqlCommas(set)}`,
  );
};

/** Remove the rows that `where` keeps. */
export const deleteFrom = <Name extends TableName>(
  table: TableHandle<Name>,
): Scoped<Name> => scoped(table, sql`DELETE FROM ${sqlName(table.name)}`);
