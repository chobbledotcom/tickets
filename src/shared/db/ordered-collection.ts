import type { InValue } from "@libsql/client";
import {
  execute,
  resultRows,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import { type NewRecord, recordsOf } from "#db/record-table.ts";
import { writeRowInTransaction } from "#db/row-write.ts";
import type { TableHandle, TableWithId } from "#db/select/tables.ts";
import {
  type SqlStatement,
  sql,
  sqlJoin,
  sqlLiteral,
  sqlName,
} from "#db/sql.ts";

type Columns = string | readonly [string, ...string[]];
type ColumnValues<Names extends Columns> = Names extends string
  ? InValue
  : { readonly [Index in keyof Names]: InValue };
type ScopeValues<Scope extends Columns | undefined> = Scope extends Columns
  ? { scope: ColumnValues<Scope> }
  : { scope?: never };
type Operation<
  Scope extends Columns | undefined,
  Fields = object,
> = ScopeValues<Scope> & Fields & { transaction?: TxScope };

type ArrangeOperation<
  Key extends Columns,
  Scope extends Columns | undefined,
> = Operation<Scope, { keys: readonly ColumnValues<Key>[] }>;

export interface OrderedCollection<
  Key extends Columns,
  Scope extends Columns | undefined,
> {
  append(
    operation: Operation<Scope, { key: ColumnValues<Key> }>,
  ): Promise<void>;
  /** Give each key its place in `keys`, in order. A key outside the scope is
   *  left alone. */
  arrange(operation: ArrangeOperation<Key, Scope>): Promise<void>;
  next(operation: Operation<Scope>): Promise<number>;
  nextMany(operation: {
    items: readonly ScopeValues<Scope>[];
    transaction?: TxScope | undefined;
  }): Promise<number[]>;
}

type FlatArrange<Key extends Columns> = (
  keys: readonly ColumnValues<Key>[],
) => Promise<void>;

export const flatCollectionArrange =
  <Key extends Columns>(
    collection: OrderedCollection<Key, undefined>,
  ): FlatArrange<Key> =>
  (keys) =>
    collection.arrange({ keys });

type ScopedArrange<Key extends Columns, Context> = (
  keys: readonly ColumnValues<Key>[],
  context: Context,
) => Promise<void>;

export const scopedCollectionArrange =
  <Key extends Columns, Scope extends Columns, Context>(
    collection: OrderedCollection<Key, Scope>,
    scopeOf: (context: Context) => ColumnValues<Scope>,
  ): ScopedArrange<Key, Context> =>
  (keys, context) =>
    collection.arrange({
      keys,
      scope: scopeOf(context),
    } as unknown as ArrangeOperation<Key, Scope>);

interface OrderedCollectionConfig<
  Key extends Columns,
  Scope extends Columns | undefined,
> {
  key: Key;
  order?: string;
  scope?: Scope;
  start?: number;
  table: string;
}

/** Run one statement in the caller's transaction, or on its own. */
const runIn = async (
  operation: { transaction?: TxScope | undefined },
  statement: SqlStatement,
): Promise<void> => {
  await (operation.transaction
    ? operation.transaction.execute(statement)
    : execute(statement));
};

const columnNames = (columns: Columns): readonly string[] =>
  typeof columns === "string" ? [columns] : columns;

const columnValues = <Names extends Columns>(
  columns: Names,
  values: ColumnValues<Names>,
): readonly InValue[] =>
  typeof columns === "string"
    ? [values as InValue]
    : (values as readonly InValue[]);

/** One equality test per column against its bound value, joined by AND. The
 * column tuple types give one value for each column. */
const equalityOf = (
  columns: readonly string[],
  values: readonly InValue[],
): SqlStatement =>
  sqlJoin(
    columns.map(
      (column, index) => sql`${sqlName(column)} = ${values[index] as InValue}`,
    ),
    sql` AND `,
  );

export const defineOrderedCollection = <
  Key extends Columns,
  Scope extends Columns | undefined = undefined,
>({
  key,
  order = "sort_order",
  scope,
  start = 0,
  table,
}: OrderedCollectionConfig<Key, Scope>): OrderedCollection<Key, Scope> => {
  const keyColumns = columnNames(key);
  const tableName = sqlName(table);
  const orderColumn = sqlName(order);
  /** The scope test for one operation, or a test every row passes when the
   * collection declares no scope. */
  const inScope = (operation: ScopeValues<Scope>): SqlStatement =>
    scope === undefined
      ? sql`1 = 1`
      : equalityOf(
          columnNames(scope),
          columnValues(scope, operation.scope as ColumnValues<Scope & Columns>),
        );
  const inTransaction = <Result>(
    operation: { transaction?: TxScope | undefined },
    run: (transaction: TxScope) => Promise<Result>,
  ): Promise<Result> => useTransaction(operation.transaction, run);

  const nextMany: OrderedCollection<Key, Scope>["nextMany"] = (operation) =>
    inTransaction(operation, async (transaction) => {
      const results = await transaction.batch(
        operation.items.map(
          (item) =>
            sql`SELECT COALESCE(MAX(${orderColumn}) + 1, ${sqlLiteral(start)}) AS next_order
                  FROM ${tableName}
                 WHERE ${inScope(item)}`,
        ),
      );
      return results.map((result) =>
        Number(resultRows<{ next_order: number }>(result)[0]!.next_order),
      );
    });

  const next: OrderedCollection<Key, Scope>["next"] = async (operation) =>
    (
      await nextMany({
        items: [operation],
        transaction: operation.transaction,
      })
    )[0]!;

  const append: OrderedCollection<Key, Scope>["append"] = async (operation) => {
    const scoped = inScope(operation);
    const keyed = columnValues(key, operation.key);
    const anotherKey = sqlJoin(
      keyColumns.map(
        (column, index) =>
          sql`${sqlName(`orderedSibling.${column}`)} != ${keyed[index] as InValue}`,
      ),
      sql` OR `,
    );
    const statement = sql`UPDATE ${tableName}
               SET ${orderColumn} = COALESCE((
                 SELECT MAX(${sqlName(`orderedSibling.${order}`)}) + 1
                   FROM ${tableName} AS orderedSibling
                   WHERE ${scoped} AND (${anotherKey})
               ), ${sqlLiteral(start)})
             WHERE ${scoped} AND ${equalityOf(keyColumns, keyed)}`;
    await runIn(operation, statement);
  };

  const arrange: OrderedCollection<Key, Scope>["arrange"] = async (
    operation,
  ) => {
    const matches = operation.keys.map((keyed) =>
      equalityOf(keyColumns, columnValues(key, keyed)),
    );
    const places = matches.map(
      (match, index) => sql`WHEN ${match} THEN ${start + index}`,
    );
    const statement = sql`UPDATE ${tableName}
               SET ${orderColumn} = CASE ${sqlJoin(places, sql` `)} END
             WHERE ${inScope(operation)}
               AND (${sqlJoin(matches, sql` OR `)})`;
    await runIn(operation, statement);
  };

  return { append, arrange, next, nextMany };
};

/** Inserts one child row under a scope and returns the new row's id. */
export type ScopedOrderedRowInsert<Input> = (
  scope: number,
  input: Input,
  log: (transaction: TxScope) => Promise<unknown>,
) => Promise<number>;

/**
 * Insert a child row and give it the next place in its scoped order. The
 * insert and any extra writes (like the log line) ride in one transaction.
 * A failed order write or log rolls the insert back with it.
 */
export const insertScopedOrderedRow =
  <Name extends TableWithId>(
    table: TableHandle<Name>,
    order: {
      append: (operation: {
        key: number;
        scope: number;
        transaction: TxScope;
      }) => Promise<void>;
    },
  ): ScopedOrderedRowInsert<NewRecord<Name>> =>
  async (scope, values, log) =>
    writeRowInTransaction(
      await recordsOf(table).insertStatement(values),
      null,
      async (transaction, id) => {
        await order.append({ key: id, scope, transaction });
        await log(transaction);
      },
    );

/** The order of a list of rows that starts at 1, and the order of the child
 *  rows inside each row of the list. Each child row names its row of the list
 *  in `scope`. */
export const listWithChildOrders = <Scope extends string>(
  list: string,
  children: string,
  scope: Scope,
) => ({
  children: defineOrderedCollection({ key: "id", scope, table: children }),
  list: defineOrderedCollection({ key: "id", start: 1, table: list }),
});
