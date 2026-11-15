// effects: pure
/**
 * Reads over the declared tables, said as functions.
 *
 * `from(table, joins)` joins along declared references. A key of `joins` names
 * a referring column of its parent table without the `_id`. `via(child, key)`
 * joins the rows of `child` whose reference points back at the parent. A join
 * is a left join when its column can hold nothing, when `via(…).optional()`
 * asks for one, or when it hangs below another left join.
 *
 * Every table in a read is a node: its properties are its columns and its
 * joined nodes. A read becomes a statement that runs alone or in a batch.
 */

import type { InValue } from "@libsql/client";
import {
  and,
  type Condition,
  type Expr,
  matchesNothing,
  matching,
  matchingNothing,
  type ValuesStatement,
  valued,
  whereTail,
  wholeCondition,
} from "#db/select/expression.ts";
import {
  type CountRow,
  type Joins,
  type Node,
  type None,
  type Out,
  type Query,
  type Selection,
  type Spec,
  type Valued,
  Via,
  type Where,
} from "#db/select/shape.ts";
import {
  type ReferenceOf,
  referenceOf,
  type TableHandle,
  type TableName,
} from "#db/select/tables.ts";
import {
  isSqlStatement,
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlCommas,
  sqlJoin,
  sqlName,
} from "#db/sql.ts";
import { bindFirst } from "#shared/fp-bind.ts";

type NodeFn<Root, Result> = (node: Root) => Result;

/** A node as the builder holds it, before the types name its columns. */
type Handle = Record<string, unknown>;

type OnHandle = NodeFn<Handle, Condition>;

/** One join that a condition describes. */
type ConditionJoin = Readonly<{
  key: string;
  table: TableHandle;
  left: boolean;
  on: OnHandle;
}>;

/** What a read says beyond its first table and its reference joins. */
type Listing<Root> = Readonly<{
  alias: string;
  joins: readonly ConditionJoin[];
  wheres: readonly NodeFn<Root, Condition | readonly Condition[]>[];
  group?: NodeFn<Root, readonly Expr<unknown>[]>;
  order?: NodeFn<Root, readonly SqlStatement[]>;
  limit?: number;
}>;

/** The FROM and JOIN text so far, and the words it gave to its tables. */
type Plan = { readonly parts: SqlStatement[]; readonly aliases: string[] };

const column = (alias: string, name: string): SqlStatement =>
  sqlName(`${alias}.${name}`);

/** The table under its word. A table that goes by its own name needs no
 *  `AS`. */
const tableAs = (table: TableHandle<string>, alias: string): SqlStatement =>
  alias === table.name
    ? sqlName(table.name)
    : sql`${sqlName(table.name)} AS ${sqlName(alias)}`;

/** The node of `table` under `alias`: one expression for each column. */
const nodeOf = (
  table: TableHandle<string>,
  alias: string,
  plan: Plan,
): Handle => {
  if (plan.aliases.includes(alias)) {
    throw new Error(`A read names two tables ${alias}. Give one another word.`);
  }
  plan.aliases.push(alias);
  return Object.fromEntries(
    table.columns.map(([name]) => [name, column(alias, name)]),
  );
};

/** Join keys that SQL reads as its own words. */
const SQL_WORDS: ReadonlySet<string> = new Set(["case", "group"]);

/** The word a joined table goes by: its key, or the key with `Row` after it
 *  where SQL reads the key as its own word. */
const wordFor = (key: string): string =>
  SQL_WORDS.has(key) ? `${key}Row` : key;

const joinWord = (left: boolean): SqlStatement =>
  left ? sql`LEFT JOIN` : sql`JOIN`;

/** Put a joined node on its parent. A key that hides a column is refused. */
const attach = (parent: Handle, key: string, child: Handle): void => {
  if (key in parent) {
    throw new Error(`The join ${key} hides a column or a join of that name.`);
  }
  parent[key] = child;
};

/** Join each key of `spec` to the node of `table`, and the joins below it. */
const joinAlong = (
  table: TableHandle<string>,
  alias: string,
  node: Handle,
  spec: Spec,
  underLeft: boolean,
  plan: Plan,
): void => {
  for (const [key, below] of Object.entries(spec)) {
    const isVia = below instanceof Via;
    const reference = isVia
      ? referenceOf(below.table, below.edge)
      : referenceOf(table, key);
    const target = isVia ? below.table : reference.target;
    const left = underLeft || (isVia ? below.left : reference.optional);
    const word = wordFor(key);
    const child = nodeOf(target, word, plan);
    const on = isVia
      ? sql`${column(word, reference.column)} = ${column(alias, "id")}`
      : sql`${column(word, "id")} = ${column(alias, reference.column)}`;
    plan.parts.push(sql`${joinWord(left)} ${tableAs(target, word)} ON ${on}`);
    attach(node, key, child);
    joinAlong(target, word, child, isVia ? below.spec : below, left, plan);
  }
};

const TABLE_WORD = /\b(?:FROM|JOIN)\s+\w+\s+AS\s+(\w+)/gi;

/** Refuse a statement that names one of this read's tables twice. A read
 *  inside this one that reuses a word hides the outer table, and SQLite then
 *  compares the inner table with itself. */
const refuseHiddenTable = (
  statement: SqlStatement,
  aliases: readonly string[],
): void => {
  const seen = new Set<string>();
  for (const [, word] of statement.sql.matchAll(TABLE_WORD)) {
    if (seen.has(word!) && aliases.includes(word!)) {
      throw new Error(
        `A read inside another names a table ${word}, which hides the outer ${word}. Use .as() to give one another word.`,
      );
    }
    seen.add(word!);
  }
};

const tail = (
  keyword: SqlStatement,
  body: SqlStatement | null,
): SqlStatement => (body === null ? sql`` : sql` ${keyword} ${body}`);

const listOrNull = (
  parts: readonly SqlStatement[] | undefined,
): SqlStatement | null =>
  parts === undefined || parts.length === 0 ? null : sqlCommas(parts);

/** The column `name` of a node. The types refuse a name that is not a
 *  column, so a miss here is a cast that hid one. */
const columnOf = (node: unknown, name: string): Expr<InValue> => {
  const held = (node as Handle)[name];
  if (!isSqlStatement(held)) {
    throw new Error(
      `A match names ${name}, which is not a column of its table.`,
    );
  }
  return valued(held);
};

const held = (node: unknown, match: object): Expr<boolean>[] =>
  matching(bindFirst(columnOf)(node), { ...match });

/** The named columns of a node, as a selection. */
export const pick = <Root, Column extends keyof Root>(
  node: Root,
  ...columns: readonly Column[]
): { [Each in Column]: Root[Each] } =>
  Object.fromEntries(columns.map((column) => [column, node[column]])) as {
    [Each in Column]: Root[Each];
  };

const asNodeTest = <Root, First>(
  conditions: Where<Root, First>,
): NodeFn<Root, Condition | readonly Condition[]> =>
  typeof conditions === "function"
    ? conditions
    : (node) => held(node, conditions);

const query = <Root, First>(
  table: TableHandle<string>,
  spec: Spec,
  listing: Listing<Root>,
): Query<Root, First> => {
  const next = (change: Partial<Listing<Root>>): Query<Root, First> =>
    query(table, spec, { ...listing, ...change });
  const joined = <Wider>(join: ConditionJoin): Query<Wider, First> =>
    query<Wider, First>(table, spec, {
      ...(listing as Listing<unknown>),
      joins: [...listing.joins, join],
    });

  /** The node, and everything after the selected columns. */
  const planned = () => {
    const { alias } = listing;
    const plan: Plan = { aliases: [], parts: [] };
    const handle = nodeOf(table, alias, plan);
    plan.parts.push(tableAs(table, alias));
    joinAlong(table, alias, handle, spec, false, plan);
    for (const join of listing.joins) {
      const word = wordFor(join.key);
      attach(handle, join.key, nodeOf(join.table, word, plan));
      plan.parts.push(
        sql`${joinWord(join.left)} ${tableAs(join.table, word)} ON ${and(
          join.on(handle),
        )}`,
      );
    }
    const node = handle as Root;
    const conditions = listing.wheres.flatMap((where) => where(node));
    return { aliases: plan.aliases, conditions, node, parts: plan.parts };
  };

  /** `SELECT columns FROM …` with every clause the read says. */
  const statement = (columns: (node: Root) => SqlStatement): SqlStatement => {
    const { aliases, conditions, node, parts } = planned();
    const built = sql`SELECT ${columns(node)} FROM ${sqlJoin(
      parts,
      sql` `,
    )}${whereTail(conditions)}${tail(
      sql`GROUP BY`,
      listOrNull(listing.group?.(node)),
    )}${tail(
      sql`ORDER BY`,
      listOrNull(listing.order?.(node)),
    )}${listing.limit === undefined ? sql`` : sql` LIMIT ${listing.limit}`}`;
    refuseHiddenTable(built, aliases);
    return conditions.some(matchesNothing) ? matchingNothing(built) : built;
  };

  return {
    aggregate: (pick) => {
      if (listing.group !== undefined) {
        throw new Error(
          "A grouped read has many rows, so it has no one value.",
        );
      }
      return valued(sql`(${statement(pick)})`);
    },
    as: (alias) => next({ alias }),
    columns: statement,
    count: () =>
      statement(() => sql`COUNT(*) AS count`) as RowsStatement<CountRow>,
    exists: () => wholeCondition(sql`EXISTS (${statement(() => sql`1`)})`),
    groupBy: (group) => next({ group }),
    join: (key, joinedTable, on) =>
      joined({ key, left: false, on: on as OnHandle, table: joinedTable }),
    leftJoin: (key, joinedTable, on) =>
      joined({ key, left: true, on: on as OnHandle, table: joinedTable }),
    limit: (limit) => next({ limit }),
    matchesNothing: () => planned().conditions.some(matchesNothing),
    orderBy: (order) => next({ order }),
    probe: () => next({ limit: 1 }).columns(() => sql`1`),
    scalar: (pick) => valued(sql`(${statement(pick)})`),
    select: <Picked extends Selection>(pick: (node: Root) => Picked) =>
      statement((node) =>
        sqlCommas(
          Object.entries(pick(node)).map(
            ([name, value]) => sql`${value} AS ${sqlName(name)}`,
          ),
        ),
      ) as RowsStatement<Out<Picked>>,
    values: <Value>(pick: Valued<Root, Value>) =>
      statement(pick) as ValuesStatement<Value>,
    where: (conditions) =>
      next({ wheres: [...listing.wheres, asNodeTest(conditions)] }),
  };
};

/** The node of `table` under `word`, for a statement that the builder does
 *  not write: a UNION, a CTE, or a write. The statement must name the table
 *  `table AS word`. */
export const tableNode = <Name extends TableName>(
  table: TableHandle<Name>,
  word: string,
): Node<Name> => nodeOf(table, word, { aliases: [], parts: [] }) as Node<Name>;

/** The spec of a read that joins nothing. It names no join, so it fits every
 *  table. */
const NO_JOINS = {} as never;

/** A read of the table under its own word, with no condition yet. */
const bareRead = <Root>(table: TableHandle<string>): Listing<Root> => ({
  alias: table.singular,
  joins: [],
  wheres: [],
});

/** Rows of `table`, joined as `spec` says. */
export const from = <Name extends TableName, const Joined extends Spec = None>(
  table: TableHandle<Name>,
  spec: Joins<Name, Joined> = NO_JOINS,
): Query<Node<Name, Joined>> => query(table, spec, bareRead(table));

/** Rows of the table of this name, for code over any table. The read has no
 *  typed node, so its conditions name their columns by text. */
export const fromNamed = (name: string): Query<unknown> => {
  const table = { columns: [], name, singular: name };
  return query(table, {}, bareRead(table));
};

/** A join of the rows of `table` whose reference `edge` points at the parent. */
export const via = <
  Name extends TableName,
  Edge extends ReferenceOf<Name>,
  const Joined extends Spec = None,
>(
  table: TableHandle<Name>,
  edge: Edge,
  spec: Joins<Name, Joined> = NO_JOINS,
): Via<Name, NoInfer<Edge>, NoInfer<Joined>, false> =>
  new Via(table, edge, spec, false);
