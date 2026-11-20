// effects: pure
/**
 * The types of a read: the joins it can name, the node of each table, and the
 * steps of a query. `query.ts` holds the code that builds the statement.
 */

import type {
  Condition,
  Counted,
  Expr,
  Operand,
  ValuesStatement,
} from "#db/select/expression.ts";
import type {
  DecodedRowOf,
  IsOptional,
  ReferenceOf,
  ReferenceTo,
  RowOf,
  TableHandle,
  TableName,
  TargetOf,
} from "#db/select/tables.ts";
import type { RowsStatement, SqlStatement } from "#db/sql.ts";

export type None = Readonly<Record<never, never>>;
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
type Refused<Reason extends string, Key, Accepted> = readonly [
  refused: Reason,
  key: Key,
  accepted: Accepted,
];

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

declare const APP: unique symbol;

/** A column of a node: SQL of its stored value. A read that picks the column
 *  itself gives the value through its codec, `App`. */
export type Column<Stored, App> = Expr<Stored> & { readonly [APP]: App };

/** The value a read gives for a picked expression. */
type ReadValue<Picked> =
  Picked extends Column<unknown, infer App>
    ? App
    : Picked extends Expr<infer Value>
      ? Value
      : never;

type Fields<Name extends TableName, Nullable extends boolean> = {
  readonly [Each in keyof RowOf<Name>]: Column<
    Maybe<RowOf<Name>[Each], Nullable>,
    Maybe<DecodedRowOf<Name>[Each], Nullable>
  >;
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
> = Fields<Name, Nullable> & {
  readonly [Key in keyof Joined]: Child<Name, Key, Joined[Key], Nullable>;
};

/** What a read gives for each row: a name for each value. */
export type Selection = { readonly [name: string]: Expr<unknown> };

/** The row a selection reads. */
export type Out<Picked extends Selection> = {
  -readonly [Name in keyof Picked]: ReadValue<Picked[Name]>;
};

/** The row of the named columns of a node. */
export type Picked<First, Column extends keyof First> = {
  -readonly [Each in Column]: ReadValue<First[Each]>;
};

/** What the columns of a node must hold. A value or an expression means
 *  "equals this", a list means "is one of these", and a null asks for a column
 *  that holds nothing. A column that the match does not name is free. */
export type Matching<Root> = {
  readonly [Column in keyof Root as Root[Column] extends Expr<unknown>
    ? Column
    : never]?: Root[Column] extends Expr<infer Value>
    ? Operand<Value> | readonly NonNullable<Value>[]
    : never;
};

/** The name of a column of a node. A read that hides its first table names
 *  no column. */
export type ColumnOf<First> = [First] extends [never]
  ? never
  : keyof Matching<First> & string;

/** Conditions on the rows of a read: a match of its first table, or
 *  conditions built from its node. */
export type Where<Root, First = Root> =
  | Matching<First>
  | ((node: Root) => Condition | readonly Condition[]);

/** A node with one more joined table under `Key`. */
type Joining<
  Root,
  Key extends string,
  Name extends TableName,
  Nullable extends boolean,
> = Root & { readonly [Each in Key]: Node<Name, None, Nullable> };

/** The one value that a read picks from its node. */
export type Valued<Root, Value> = (node: Root) => Expr<Value>;

/** The one row of a count. */
export type CountRow = { count: Counted };

/** A join of `table` under `key`, where `on` holds. */
type JoinStep<Root, First, Nullable extends boolean> = <
  Key extends string,
  Name extends TableName,
>(
  key: Key,
  table: TableHandle<Name>,
  on: (node: Joining<Root, Key, Name, Nullable>) => Condition,
) => Query<Joining<Root, Key, Name, Nullable>, First>;

/** A read in the making. `Root` is the node that its conditions see, and
 *  `First` is the node of its first table, which a match names the columns
 *  of. A read with more joins serves where a read with fewer is asked for. */
export type Query<Root, First = Root> = Readonly<{
  /** The one value of a read that folds every row, as an expression. A fold
   *  with no group always has a row, so the value is never missing. */
  aggregate: <Value>(pick: Valued<Root, Value>) => Expr<Value>;
  /** The read with its first table under another word. A table that a
   *  statement reads twice needs a word for each place. */
  as: (alias: string) => Query<Root, First>;
  /** The statement that reads every column of the first table. */
  everyColumn: () => RowsStatement<Picked<First, ColumnOf<First>>>;
  /** The statement that reads the named columns of the first table. */
  pick: <Column extends ColumnOf<First>>(
    ...columns: readonly Column[]
  ) => RowsStatement<Picked<First, Column>>;
  /** The statement that reads a column list written by hand. The caller names
   *  the type of the rows. */
  columns: (pick: (node: Root) => SqlStatement) => SqlStatement;
  /** The statement that counts the rows of the read. */
  count: () => RowsStatement<CountRow>;
  /** Whether the read has a row, as a condition. */
  exists: () => Expr<boolean>;
  /** The read with its rows folded by these values. */
  groupBy: (by: (node: Root) => readonly Expr<unknown>[]) => Query<Root, First>;
  /** The read with `table` joined under `key`, where `on` holds. */
  join: JoinStep<Root, First, false>;
  /** The same join, where a row with no match stays and the joined columns
   *  are null. */
  leftJoin: JoinStep<Root, First, true>;
  /** The read with its rows in the order of these columns of the first
   *  table. */
  sortedBy: (...columns: readonly ColumnOf<First>[]) => Query<Root, First>;
  /** The read with at most `count` rows. */
  limit: (count: number) => Query<Root, First>;
  /** Whether no row can pass the conditions, so a runner can skip the read. */
  matchesNothing: () => boolean;
  /** The read with its rows in this order. */
  orderBy: (
    order: (node: Root) => readonly SqlStatement[],
  ) => Query<Root, First>;
  /** The statement that gives one row when the read has a row. */
  probe: () => SqlStatement;
  /** The value of the first row, as an expression. Null with no row. */
  scalar: <Value>(pick: Valued<Root, Value>) => Expr<Value | null>;
  /** The statement that reads each row as the picked names. */
  select: <Picked extends Selection>(
    pick: (node: Root) => Picked,
  ) => RowsStatement<Out<Picked>>;
  /** The statement that reads one unnamed value for each row. */
  values: <Value>(pick: Valued<Root, Value>) => ValuesStatement<Value>;
  /** The read with more conditions. */
  where: (conditions: Where<Root, First>) => Query<Root, First>;
}>;

/** The node that the conditions of a read see. */
export type NodeOf<Read> = Read extends Query<infer Root, never> ? Root : never;
