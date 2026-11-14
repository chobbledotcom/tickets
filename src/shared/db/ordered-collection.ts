import type { InValue } from "@libsql/client";
import {
  execute,
  resultRows,
  type TxScope,
  useTransaction,
  writeRowInTransaction,
} from "#db/client.ts";
import {
  type SqlStatement,
  sql,
  sqlJoin,
  sqlLiteral,
  sqlName,
  sqlNames,
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

type SwapOperation<
  Key extends Columns,
  Scope extends Columns | undefined,
> = Operation<Scope, { first: ColumnValues<Key>; second: ColumnValues<Key> }>;

export interface OrderedCollection<
  Key extends Columns,
  Scope extends Columns | undefined,
> {
  append(
    operation: Operation<Scope, { key: ColumnValues<Key> }>,
  ): Promise<void>;
  next(operation: Operation<Scope>): Promise<number>;
  nextMany(operation: {
    items: readonly ScopeValues<Scope>[];
    transaction?: TxScope | undefined;
  }): Promise<number[]>;
  swap(operation: SwapOperation<Key, Scope>): Promise<void>;
}

type FlatSwap<Key extends Columns> = (
  first: ColumnValues<Key>,
  second: ColumnValues<Key>,
) => Promise<void>;

export const flatCollectionSwap =
  <Key extends Columns>(
    collection: OrderedCollection<Key, undefined>,
  ): FlatSwap<Key> =>
  (first, second) =>
    collection.swap({ first, second });

type ScopedSwap<Key extends Columns, Context> = (
  first: ColumnValues<Key>,
  second: ColumnValues<Key>,
  context: Context,
) => Promise<void>;

export const scopedCollectionSwap =
  <Key extends Columns, Scope extends Columns, Context>(
    collection: OrderedCollection<Key, Scope>,
    scopeOf: (context: Context) => ColumnValues<Scope>,
  ): ScopedSwap<Key, Context> =>
  (first, second, context) =>
    collection.swap({
      first,
      scope: scopeOf(context),
      second,
    } as unknown as SwapOperation<Key, Scope>);

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
      (column, index) =>
        sql`${sqlName(column)} = ${values[index] as InValue}`,
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
  const scopeColumns = scope === undefined ? undefined : columnNames(scope);
  const tableName = sqlName(table);
  const orderColumn = sqlName(order);
  const scopeArgs = (operation: ScopeValues<Scope>): readonly InValue[] =>
    scope === undefined
      ? []
      : columnValues(scope, operation.scope as ColumnValues<Scope & Columns>);
  /** The scope test for one operation, or a test every row passes when the
   * collection declares no scope. */
  const inScope = (operation: ScopeValues<Scope>): SqlStatement =>
    scopeColumns === undefined
      ? sql`1 = 1`
      : equalityOf(scopeColumns, scopeArgs(operation));
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
    await (operation.transaction
      ? operation.transaction.execute(statement)
      : execute(statement));
  };

  const swap: OrderedCollection<Key, Scope>["swap"] = (operation) =>
    inTransaction(operation, async (transaction) => {
      const first = equalityOf(keyColumns, columnValues(key, operation.first));
      const second = equalityOf(
        keyColumns,
        columnValues(key, operation.second),
      );
      const differentKey = sqlJoin(
        keyColumns.map(
          (column) =>
            sql`${sqlName(`swapping.${column}`)} != ${sqlName(`orderedItem.${column}`)}`,
        ),
        sql` OR `,
      );
      const swapped = sql`${inScope(operation)} AND (${first} OR ${second})`;
      await transaction.execute(
        sql`WITH swapping AS MATERIALIZED (
                SELECT ${sqlNames([...keyColumns, order])}
                  FROM ${tableName}
                 WHERE ${swapped}
              )
              UPDATE ${tableName} AS orderedItem
                 SET ${orderColumn} = (
                   SELECT ${orderColumn}
                     FROM swapping
                    WHERE ${differentKey}
                 )
               WHERE ${swapped}
                 AND (SELECT COUNT(*) FROM swapping) = 2`,
      );
    });

  return { append, next, nextMany, swap };
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
  <Input>(
    table: {
      insertStatement: (input: Input) => Promise<SqlStatement>;
    },
    order: {
      append: (operation: {
        key: number;
        scope: number;
        transaction: TxScope;
      }) => Promise<void>;
    },
  ): ScopedOrderedRowInsert<Input> =>
  async (scope, input, log) =>
    writeRowInTransaction(
      await table.insertStatement(input),
      null,
      async (transaction, id) => {
        await order.append({ key: id, scope, transaction });
        await log(transaction);
      },
    );
