/**
 * One record, named by its kind and its id — the shape used by everything that
 * hangs off "any record": notes about a record, images attached to a record,
 * the items a site page points at.
 *
 * A domain says which kinds it allows and which two columns hold them, and gets
 * back the whole vocabulary: how to name a record, a stable key for one, the
 * clauses that ask for one or many, the deletes, and (when it lists the table
 * each kind lives in) a check that the record is really there.
 *
 * This module is pure: it says what a target is and how to ask for one in SQL,
 * and never touches the database itself.
 */

import type { SqlStatement } from "#db/client.ts";
import {
  deleteWhere,
  equals,
  inList,
  inSubquery,
  type WhereClause,
} from "#db/where-clauses.ts";

/** One record: what kind of thing it is, and which one of that kind. */
export interface RecordTarget<Kind extends string> {
  id: number;
  kind: Kind;
}

/** A stable string name for one record, safe to compare, sort, and use as a
 *  map key. */
export type RecordTargetKey<Kind extends string> = `${Kind}:${number}`;

/** How a stored row spells a target: the column holding the kind, and the one
 *  holding the id. */
interface RecordTargetColumns {
  id: string;
  kind: string;
}

/** What a domain must say to get its target vocabulary. */
interface RecordTargetConfig<Kind extends string> {
  /** The columns the kind and id are stored in. */
  columns: RecordTargetColumns;
  /** The kinds of record this domain accepts. */
  kinds: readonly Kind[];
  /** The table each kind lives in, when the domain wants existence checks.
   *  Every value must be a trusted constant, never anything a user typed. */
  tables?: Readonly<Record<Kind, string>>;
}

/** The vocabulary one domain gets for naming and querying its records. */
export interface RecordTargets<Kind extends string> {
  /** Delete the rows of the records another query chooses. */
  deleteChosenBy: (
    table: string,
  ) => (kind: Kind, idsQuery: SqlStatement) => SqlStatement;
  /** Delete one record's rows from `table` (a trusted constant). */
  deleteFrom: (table: string) => (target: RecordTarget<Kind>) => SqlStatement;
  /** A condition that only holds while the record itself still exists, to fold
   *  into a write so a stale request cannot leave a link to nothing. */
  exists: (target: RecordTarget<Kind>) => SqlStatement;
  /** The record a key names. Refuses a key this domain could not have minted,
   *  because a key that names no record of ours is a bug, not a miss. */
  fromKey: (key: RecordTargetKey<Kind>) => RecordTarget<Kind>;
  /** The stable key for one record. */
  key: (target: RecordTarget<Kind>) => RecordTargetKey<Kind>;
  /** Name records of one kind: `of("listing")(7)`. */
  of: (kind: Kind) => (id: number) => RecordTarget<Kind>;
  /** The same records with repeats dropped, keeping the first of each. */
  unique: (targets: readonly RecordTarget<Kind>[]) => RecordTarget<Kind>[];
  /** Ask for one record's rows. Pass a table alias when the read joins. */
  where: (target: RecordTarget<Kind>, alias?: string) => WhereClause[];
  /** Ask for the records of one kind that another query chooses. */
  whereChosenBy: (kind: Kind, idsQuery: SqlStatement) => WhereClause[];
  /** Ask for several records of one kind. Asking for none of them is a
   *  question no row can answer, which the reader sees and skips. */
  whereMany: (kind: Kind, ids: number[], alias?: string) => WhereClause[];
}

/** The columns a table uses when its rows hang off any record — the spelling
 * shared by image links and page items. */
export const ITEM_TARGET_COLUMNS: RecordTargetColumns = {
  id: "item_id",
  kind: "item_type",
};

/** Prefix a column with its table alias, when the read gave one. */
const column = (alias: string | undefined, name: string): string =>
  alias === undefined ? name : `${alias}.${name}`;

/** Build the naming and querying vocabulary for one domain's records. */
export const defineRecordTarget = <Kind extends string>({
  columns,
  kinds,
  tables,
}: RecordTargetConfig<Kind>): RecordTargets<Kind> => {
  const ofKind = (alias: string | undefined, kind: Kind): WhereClause[] =>
    equals(column(alias, columns.kind), kind);

  const key = (target: RecordTarget<Kind>): RecordTargetKey<Kind> =>
    `${target.kind}:${target.id}`;

  const whereChosenBy = (kind: Kind, idsQuery: SqlStatement): WhereClause[] => [
    ...ofKind(undefined, kind),
    ...inSubquery(columns.id, idsQuery),
  ];

  const where = (target: RecordTarget<Kind>, alias?: string): WhereClause[] => [
    ...ofKind(alias, target.kind),
    ...equals(column(alias, columns.id), target.id),
  ];

  return {
    deleteChosenBy: (table) => (kind, idsQuery) =>
      deleteWhere(table)(whereChosenBy(kind, idsQuery)),
    deleteFrom: (table) => (target) => deleteWhere(table)(where(target)),
    exists: (target) => {
      if (!tables) {
        throw new Error(
          `No table listed for ${target.kind} records: this kind of target cannot be checked for existence`,
        );
      }
      return {
        args: [target.id],
        sql: `EXISTS (SELECT 1 FROM ${tables[target.kind]} WHERE id = ?)`,
      };
    },
    fromKey: (stored) => {
      const divider = stored.indexOf(":");
      const kind = kinds.find(
        (allowed) => allowed === stored.slice(0, divider),
      );
      const id = Number(stored.slice(divider + 1));
      if (kind === undefined || !Number.isSafeInteger(id)) {
        throw new Error(`Not the name of a record here: ${stored}`);
      }
      return { id, kind };
    },
    key,
    of: (kind) => (id) => ({ id, kind }),
    unique: (targets) => [
      ...new Map(targets.map((target) => [key(target), target])).values(),
    ],
    where,
    whereChosenBy,
    whereMany: (kind, ids, alias) => [
      ...ofKind(alias, kind),
      ...inList(column(alias, columns.id), ids),
    ],
  };
};
