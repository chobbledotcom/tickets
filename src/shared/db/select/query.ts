// effects: pure
/**
 * Reads over the declared tables, said as functions.
 *
 * `from(table, joins)` joins along declared references. A key of `joins` names
 * a referring column of its parent table without the `_id`. `via(child, key)`
 * joins the rows of `child` whose reference points back at the parent. A join
 * is a left join when its column can hold nothing, when `via(…).optional()`
 * asks for one, or when it hangs below another left join. `.join()` and
 * `.leftJoin()` take a condition for a join that follows no reference.
 *
 * Every table in a read is a node: its properties are its columns and its
 * joined nodes. Conditions, orders and selections are built from nodes. A read
 * becomes a statement, so it runs alone, in a batch, or inside a write.
 *
 * ```ts
 * // The quantity a listing has booked, for a guard inside an INSERT.
 * from(tables.listing_attendees)
 *   .where((line) => equal(line.listing_id, listingId))
 *   .scalar((line) => sum(line.quantity));
 *
 * // The groups a listing belongs to that carry a cap.
 * from(tables.group_listings, { group: {} })
 *   .where((member) => [
 *     equal(member.listing_id, listingId),
 *     greaterThan(member.group.max_attendees, 0),
 *   ])
 *   .select((member) => ({ id: member.group.id }));
 * ```
 */

import {
  and,
  type Condition,
  type Expr,
  matchesNothing,
  type ValuesStatement,
  valued,
  whereTail,
  wholeCondition,
} from "#db/select/expression.ts";
import {
  type IsOptional,
  type ReferenceOf,
  type ReferenceTo,
  type RowOf,
  referenceOf,
  type TableHandle,
  type TableName,
  type TargetOf,
  tableNamed,
} from "#db/select/tables.ts";
import {
  type RowsStatement,
  type SqlStatement,
  sql,
  sqlCommas,
  sqlJoin,
  sqlName,
} from "#db/sql.ts";

type None = Readonly<Record<never, never>>;
type Or<A extends boolean, B extends boolean> = A extends true ? true : B;
type Maybe<Value, Nullable extends boolean> = Nullable extends true
  ? Value | null
  : Value;

/** The rows of `table` whose reference `edge` points at the parent node, with
 *  their own joins. */
export class Via<
  Name extends TableName,
  Edge extends string,
  Joined,
  Left extends boolean,
> {
  constructor(
    readonly table: TableHandle<Name>,
    readonly edge: Edge,
    readonly spec: Joined,
    readonly left: Left,
  ) {}

  /** The join as a left join: a parent with no referring row stays, and the
   *  joined columns are null. */
  optional(): Via<Name, Edge, Joined, true> {
    return new Via(this.table, this.edge, this.spec, true);
  }
}

/** What a read joins: for each key, the joins below a reference of the parent,
 *  or a `via` join. */
export type Spec = {
  readonly [key: string]: Spec | Via<TableName, string, Spec, boolean>;
};

/** Why a join key is refused, the key, and what the table accepts instead. */
type Refused<Reason extends string, Key, Accepted> = Readonly<{
  refused: Reason;
  key: Key;
  accepted: Accepted;
}>;

/** `Joined` where each key names a reference of `Name`, or a `via` join whose
 *  reference points at `Name`. */
type Valid<Name extends TableName, Joined> = {
  readonly [Key in keyof Joined]: Joined[Key] extends Via<
    infer Child,
    infer Edge,
    unknown,
    boolean
  >
    ? Edge extends ReferenceTo<Child, Name>
      ? Joined[Key]
      : Refused<
          "this via reference does not point at the parent table",
          Edge,
          ReferenceTo<Child, Name>
        >
    : Key extends ReferenceOf<Name>
      ? Valid<TargetOf<Name, Key>, Joined[Key]>
      : Refused<"not a reference of the parent table", Key, ReferenceOf<Name>>;
};

/** The joins of a read from `Name`, refused where a key does not join. */
export type Joins<Name extends TableName, Joined> = Joined &
  Valid<Name, Joined>;

type Fields<Row, Nullable extends boolean> = {
  readonly [Column in keyof Row]: Expr<Maybe<Row[Column], Nullable>>;
};

type Child<Name extends TableName, Key, Joined, Nullable extends boolean> =
  Joined extends Via<infer Target, string, infer Below, infer Optional>
    ? Node<Target, Below, Or<Nullable, Optional>>
    : Key extends ReferenceOf<Name>
      ? Node<TargetOf<Name, Key>, Joined, Or<Nullable, IsOptional<Name, Key>>>
      : never;

/** A table in a read: its columns and its joined nodes. */
export type Node<
  Name extends TableName,
  Joined = None,
  Nullable extends boolean = false,
> = Fields<RowOf<Name>, Nullable> & {
  readonly [Key in keyof Joined]: Child<Name, Key, Joined[Key], Nullable>;
};

/** What a read gives for each row: a name for each value. */
export type Selection = { readonly [name: string]: Expr<unknown> };

/** The row a selection reads. */
export type Out<Picked extends Selection> = {
  -readonly [Name in keyof Picked]: Picked[Name] extends Expr<infer Value>
    ? Value
    : never;
};

/** A node with one more joined table under `Key`. */
type Joining<
  Root,
  Key extends string,
  Name extends TableName,
  Nullable extends boolean,
> = Root & { readonly [Each in Key]: Node<Name, None, Nullable> };

export type Query<Root> = Readonly<{
  /** The read with its first table under another word. A table that a
   *  statement reads twice needs a word for each place. */
  as: (alias: string) => Query<Root>;
  /** The read with `table` joined under `key`, where `on` holds. */
  join: <Key extends string, Name extends TableName>(
    key: Key,
    table: TableHandle<Name>,
    on: (node: Joining<Root, Key, Name, false>) => Condition,
  ) => Query<Joining<Root, Key, Name, false>>;
  /** The same join, where a row with no match stays and the joined columns
   *  are null. */
  leftJoin: <Key extends string, Name extends TableName>(
    key: Key,
    table: TableHandle<Name>,
    on: (node: Joining<Root, Key, Name, true>) => Condition,
  ) => Query<Joining<Root, Key, Name, true>>;
  /** The read with more conditions. */
  where: (
    conditions: (node: Root) => Condition | readonly Condition[],
  ) => Query<Root>;
  /** The read with its rows folded by these values. */
  groupBy: (by: (node: Root) => readonly Expr<unknown>[]) => Query<Root>;
  /** The read with its rows in this order. */
  orderBy: (order: (node: Root) => readonly SqlStatement[]) => Query<Root>;
  /** The read with at most `count` rows. */
  limit: (count: number) => Query<Root>;
  /** Whether no row can pass the conditions, so a runner can skip the read. */
  matchesNothing: () => boolean;
  /** The statement that reads each row as the picked names. */
  select: <Picked extends Selection>(
    pick: (node: Root) => Picked,
  ) => RowsStatement<Out<Picked>>;
  /** The statement that reads a column list written by hand. The caller names
   *  the type of the rows. */
  columns: (pick: (node: Root) => SqlStatement) => SqlStatement;
  /** The statement that reads one unnamed value for each row. */
  values: <Value>(pick: (node: Root) => Expr<Value>) => ValuesStatement<Value>;
  /** The value of the first row, as an expression. Null with no row. */
  scalar: <Value>(pick: (node: Root) => Expr<Value>) => Expr<Value | null>;
  /** The one value of a read that folds every row, as an expression. A fold
   *  with no group always has a row, so the value is never missing. */
  aggregate: <Value>(pick: (node: Root) => Expr<Value>) => Expr<Value>;
  /** Whether the read has a row, as a condition. */
  exists: () => Expr<boolean>;
}>;

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
  alias?: string;
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

const tableAs = (table: TableHandle, alias: string): SqlStatement =>
  sql`${sqlName(table.name)} AS ${sqlName(alias)}`;

/** The node of `table` under `alias`: one expression for each column. */
const nodeOf = (table: TableHandle, alias: string, plan: Plan): Handle => {
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
  table: TableHandle,
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

/** Statements whose conditions no row can pass. */
const emptyReads = new WeakSet<SqlStatement>();

/** Whether no row can pass the conditions of a read from the builder, so a
 *  runner can answer it with no rows and skip the database. */
export const readsNothing = (statement: SqlStatement): boolean =>
  emptyReads.has(statement);

const tail = (
  keyword: SqlStatement,
  body: SqlStatement | null,
): SqlStatement => (body === null ? sql`` : sql` ${keyword} ${body}`);

const listOrNull = (
  parts: readonly SqlStatement[] | undefined,
): SqlStatement | null =>
  parts === undefined || parts.length === 0 ? null : sqlCommas(parts);

const query = <Root>(
  table: TableHandle,
  spec: Spec,
  listing: Listing<Root>,
): Query<Root> => {
  const next = (change: Partial<Listing<Root>>): Query<Root> =>
    query(table, spec, { ...listing, ...change });
  const joined = <Wider>(join: ConditionJoin): Query<Wider> =>
    query<Wider>(table, spec, {
      ...(listing as Listing<unknown>),
      joins: [...listing.joins, join],
    });

  /** The node, and everything after the selected columns. */
  const planned = () => {
    const alias = listing.alias ?? table.singular;
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
    if (conditions.some(matchesNothing)) emptyReads.add(built);
    return built;
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
    exists: () => wholeCondition(sql`EXISTS (${statement(() => sql`1`)})`),
    groupBy: (group) => next({ group }),
    join: (key, joinedTable, on) =>
      joined({ key, left: false, on: on as OnHandle, table: joinedTable }),
    leftJoin: (key, joinedTable, on) =>
      joined({ key, left: true, on: on as OnHandle, table: joinedTable }),
    limit: (limit) => next({ limit }),
    matchesNothing: () => planned().conditions.some(matchesNothing),
    orderBy: (order) => next({ order }),
    scalar: (pick) => valued(sql`(${statement(pick)})`),
    select: <Picked extends Selection>(pick: (node: Root) => Picked) =>
      statement((node) =>
        sqlCommas(
          Object.entries(pick(node)).map(
            ([name, value]) => sql`${value} AS ${sqlName(name)}`,
          ),
        ),
      ) as RowsStatement<Out<Picked>>,
    values: <Value>(pick: (node: Root) => Expr<Value>) =>
      statement(pick) as ValuesStatement<Value>,
    where: (conditions) => next({ wheres: [...listing.wheres, conditions] }),
  };
};

/** The node of `table` under `word`, for a statement that the builder does
 *  not write: a UNION, a CTE, or a write. The statement must name the table
 *  `table AS word`. */
export const tableNode = <Name extends TableName>(
  table: TableHandle<Name>,
  word: string,
): Node<Name> => nodeOf(table, word, { aliases: [], parts: [] }) as Node<Name>;

/** Rows of `table`, joined as `spec` says. */
export const from = <Name extends TableName, const Joined extends Spec = None>(
  table: TableHandle<Name>,
  spec: Joins<Name, Joined> = {} as Joins<Name, Joined>,
): Query<Node<Name, Joined>> => query(table, spec, { joins: [], wheres: [] });

/** Rows of the table of this name, for code over any table. The read has no
 *  typed node, so its conditions name their columns by text. */
export const fromNamed = (name: string): Query<unknown> =>
  query(tableNamed(name), {}, { joins: [], wheres: [] });

/** A join of the rows of `table` whose reference `edge` points at the parent. */
export const via = <
  Name extends TableName,
  Edge extends ReferenceOf<Name>,
  const Joined extends Spec = None,
>(
  table: TableHandle<Name>,
  edge: Edge,
  spec: Joins<Name, Joined> = {} as Joins<Name, Joined>,
): Via<Name, NoInfer<Edge>, NoInfer<Joined>, false> =>
  new Via(table, edge, spec, false);
