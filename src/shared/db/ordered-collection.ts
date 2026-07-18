import type { InValue, Row } from "@libsql/client";
import {
  execute,
  resultRows,
  type TxScope,
  useTransaction,
} from "#shared/db/client.ts";

type Columns = string | readonly [string, ...string[]];
type Values<Names extends Columns> = Names extends string
  ? InValue
  : { readonly [Index in keyof Names]: InValue };
type ScopeValues<Scope extends Columns | undefined> = Scope extends Columns
  ? { scope: Values<Scope> }
  : { scope?: never };
type Operation<Scope extends Columns | undefined> = ScopeValues<Scope> & {
  transaction?: TxScope;
};
type NextManyOperation<Scope extends Columns | undefined> = {
  items: readonly ScopeValues<Scope>[];
  transaction?: TxScope | undefined;
};
type KeysOperation<Scope extends Columns | undefined, Keys> = Operation<Scope> &
  Keys;
type KeyOperation<
  Key extends Columns,
  Scope extends Columns | undefined,
> = KeysOperation<Scope, { key: Values<Key> }>;
type SwapOperation<
  Key extends Columns,
  Scope extends Columns | undefined,
> = KeysOperation<Scope, { first: Values<Key>; second: Values<Key> }>;

export interface OrderedCollection<
  Key extends Columns,
  Scope extends Columns | undefined,
> {
  append: (operation: KeyOperation<Key, Scope>) => Promise<void>;
  next: (operation: Operation<Scope>) => Promise<number>;
  nextMany: (operation: NextManyOperation<Scope>) => Promise<number[]>;
  swap: (operation: SwapOperation<Key, Scope>) => Promise<void>;
}

type FlatSwap<Key extends Columns> = (
  first: Values<Key>,
  second: Values<Key>,
) => Promise<void>;

/** Adapt a flat descriptor's swap to collection-handler callback arguments. */
export const flatCollectionSwap =
  <Key extends Columns>(
    collection: OrderedCollection<Key, undefined>,
  ): FlatSwap<Key> =>
  (first, second) =>
    collection.swap({ first, second });

type ScopedSwap<Key extends Columns, Context> = (
  first: Values<Key>,
  second: Values<Key>,
  context: Context,
) => Promise<void>;

/** Bind a handler context's scope to every swap through a scoped descriptor. */
export const scopedCollectionSwap =
  <Key extends Columns, Scope extends Columns, Context>(
    collection: OrderedCollection<Key, Scope>,
    scopeOf: (context: Context) => Values<Scope>,
  ): ScopedSwap<Key, Context> =>
  (first, second, context) =>
    collection.swap({
      first,
      scope: scopeOf(context),
      second,
    } as unknown as SwapOperation<Key, Scope>);

type OrderedCollectionDescriptor<
  Key extends Columns,
  Scope extends Columns | undefined,
> = {
  key: Key;
  order?: string;
  scope?: Scope;
  start?: number;
  table: string;
};

const columnNames = (columns: Columns | undefined): readonly string[] =>
  columns === undefined
    ? []
    : typeof columns === "string"
      ? [columns]
      : columns;

const columnValues = <Names extends Columns>(
  columns: Names,
  values: Values<Names>,
): readonly InValue[] =>
  typeof columns === "string"
    ? [values as InValue]
    : (values as readonly InValue[]);

const matches = (columns: readonly string[]): string =>
  columns.map((column) => `${column} = ?`).join(" AND ");

const sameValues = (first: readonly InValue[], second: readonly InValue[]) =>
  first.every((value, index) => value === second[index]);

/**
 * Bind ordered-row operations to trusted internal SQL identifiers. A descriptor
 * may name one or many key columns and an optional one-or-many-column scope.
 */
export const defineOrderedCollection = <
  Key extends Columns,
  Scope extends Columns | undefined = undefined,
>({
  key,
  order = "sort_order",
  scope,
  start = 0,
  table,
}: OrderedCollectionDescriptor<Key, Scope>): OrderedCollection<Key, Scope> => {
  const keyColumns = columnNames(key);
  const scopeColumns = columnNames(scope);
  const scopeArgs = (operation: ScopeValues<Scope>): readonly InValue[] =>
    scope === undefined
      ? []
      : columnValues(scope, operation.scope as Values<Scope & Columns>);
  const scopeWhere = (): string =>
    scopeColumns.length === 0 ? "" : `${matches(scopeColumns)} AND `;
  const rowWhere = (
    values: readonly InValue[],
    scoped: readonly InValue[],
  ): { args: InValue[]; sql: string } => ({
    args: [...scoped, ...values],
    sql: `${scopeWhere()}${matches(keyColumns)}`,
  });

  const nextStatement = (item: ScopeValues<Scope>) => ({
    args: [...scopeArgs(item)],
    sql: `SELECT COALESCE(MAX(${order}) + 1, ${start}) AS next_order
            FROM ${table}
           WHERE ${scopeWhere().replace(/ AND $/, "") || "1 = 1"}`,
  });
  const nextMany = (operation: NextManyOperation<Scope>): Promise<number[]> =>
    useTransaction(operation.transaction, async (transaction) => {
      const results = await transaction.batch(
        operation.items.map(nextStatement),
      );
      return results.map((result) =>
        Number(resultRows<{ next_order: number }>(result)[0]!.next_order),
      );
    });
  const next = async (operation: Operation<Scope>): Promise<number> =>
    (
      await nextMany({
        items: [operation],
        transaction: operation.transaction,
      })
    )[0]!;

  const append = async (operation: KeyOperation<Key, Scope>): Promise<void> => {
    const scoped = scopeArgs(operation);
    const keyed = columnValues(key, operation.key);
    const where = rowWhere(keyed, scoped);
    const statement = {
      args: [...scoped, ...keyed, ...where.args],
      sql: `UPDATE ${table}
               SET ${order} = COALESCE((
                 SELECT MAX(orderedSibling.${order}) + 1
                   FROM ${table} AS orderedSibling
                   WHERE ${scopeWhere()}${keyColumns
                     .map((column) => `orderedSibling.${column} != ?`)
                     .join(" OR ")}
               ), ${start})
             WHERE ${where.sql}`,
    };
    if (operation.transaction) {
      await operation.transaction.execute(statement);
    } else {
      await execute(statement.sql, statement.args);
    }
  };

  const swap = (operation: SwapOperation<Key, Scope>): Promise<void> =>
    useTransaction(operation.transaction, async (transaction) => {
      const scoped = scopeArgs(operation);
      const first = columnValues(key, operation.first);
      const second = columnValues(key, operation.second);
      if (sameValues(first, second)) return;
      const rows = resultRows<Row>(
        await transaction.execute({
          args: [...scoped, ...first, ...second],
          sql: `SELECT ${[...keyColumns, order].join(", ")}
                  FROM ${table}
                 WHERE ${scopeWhere()}(${matches(keyColumns)} OR ${matches(
                   keyColumns,
                 )})`,
        }),
      );
      const orderFor = (values: readonly InValue[]): number | undefined =>
        rows.find((row) =>
          keyColumns.every((column, index) => row[column] === values[index]),
        )?.[order] as number | undefined;
      const firstOrder = orderFor(first);
      const secondOrder = orderFor(second);
      if (firstOrder === undefined || secondOrder === undefined) return;
      const setOrder = (values: readonly InValue[], value: number) => {
        const where = rowWhere(values, scoped);
        return {
          args: [value, ...where.args],
          sql: `UPDATE ${table} SET ${order} = ? WHERE ${where.sql}`,
        };
      };
      await transaction.batch([
        setOrder(first, secondOrder),
        setOrder(second, firstOrder),
      ]);
    });

  return { append, next, nextMany, swap };
};
