import type { InValue } from "@libsql/client";
import {
  execute,
  resultRows,
  type TxScope,
  useTransaction,
} from "#shared/db/client.ts";

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

const matches = (columns: readonly string[]): string =>
  columns.map((column) => `${column} = ?`).join(" AND ");

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
  const scopeClause =
    scope === undefined ? "1 = 1" : matches(columnNames(scope));
  const scopeWhere = `${scopeClause} AND `;
  const scopeArgs = (operation: ScopeValues<Scope>): readonly InValue[] =>
    scope === undefined
      ? []
      : columnValues(scope, operation.scope as ColumnValues<Scope & Columns>);
  const inTransaction = <Result>(
    operation: { transaction?: TxScope | undefined },
    run: (transaction: TxScope) => Promise<Result>,
  ): Promise<Result> => useTransaction(operation.transaction, run);

  const nextMany: OrderedCollection<Key, Scope>["nextMany"] = (operation) =>
    inTransaction(operation, async (transaction) => {
      const results = await transaction.batch(
        operation.items.map((item) => ({
          args: [...scopeArgs(item)],
          sql: `SELECT COALESCE(MAX(${order}) + 1, ${start}) AS next_order
                  FROM ${table}
                 WHERE ${scopeClause}`,
        })),
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
    const scoped = scopeArgs(operation);
    const keyed = columnValues(key, operation.key);
    const statement = {
      args: [...scoped, ...keyed, ...scoped, ...keyed],
      sql: `UPDATE ${table}
               SET ${order} = COALESCE((
                 SELECT MAX(orderedSibling.${order}) + 1
                   FROM ${table} AS orderedSibling
                  WHERE ${scopeWhere}${keyColumns
                    .map((column) => `orderedSibling.${column} != ?`)
                    .join(" OR ")}
               ), ${start})
             WHERE ${scopeWhere}${matches(keyColumns)}`,
    };
    await (operation.transaction
      ? operation.transaction.execute(statement)
      : execute(statement.sql, statement.args));
  };

  const swap: OrderedCollection<Key, Scope>["swap"] = (operation) =>
    inTransaction(operation, async (transaction) => {
      const first = columnValues(key, operation.first);
      const second = columnValues(key, operation.second);
      const pair = `(${matches(keyColumns)} OR ${matches(keyColumns)})`;
      const differentKey = keyColumns
        .map((column) => `swapping.${column} != orderedItem.${column}`)
        .join(" OR ");
      await transaction.execute({
        args: [
          scopeArgs(operation),
          first,
          second,
          scopeArgs(operation),
          first,
          second,
        ].flat(),
        sql: `WITH swapping AS MATERIALIZED (
                SELECT ${[...keyColumns, order].join(", ")}
                  FROM ${table}
                 WHERE ${scopeWhere}${pair}
              )
              UPDATE ${table} AS orderedItem
                 SET ${order} = (
                   SELECT ${order}
                     FROM swapping
                    WHERE ${differentKey}
                 )
               WHERE ${scopeWhere}${pair}
                 AND (SELECT COUNT(*) FROM swapping) = 2`,
      });
    });

  return { append, next, nextMany, swap };
};
