/**
 * One shared shape for the app's simple link tables — the small two-column
 * tables that connect one kind of record to another (user ↔ logistics agent,
 * parent listing ↔ child listing, modifier ↔ listing/group).
 *
 * Each of those modules used to hand-write the same three pieces: read the
 * linked ids, replace the whole set (delete everything for the key, insert the
 * new rows), and clear the links for a key. `linkTableSide` builds all of them
 * from one declaration, so the batch shape, the dedupe rule, and the ordering
 * live in one place.
 *
 * A "side" is one direction through the table: `keyColumn` is the record you
 * already have, `valueColumn` is the ids you want. Declare one side per
 * direction the module actually uses. Table and column names are internal
 * constants, never user input.
 */

import { unique } from "#fp";
import {
  deleteByField,
  executeBatch,
  queryIdColumn,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";

/** A link write run on a caller's open write transaction. */
type TxIdsWrite = (
  tx: TxScope,
  keyId: number,
  ids: readonly number[],
) => Promise<void>;

export type LinkTableSide = {
  /** Add links for a key without touching its existing rows (one multi-row
   * INSERT), inside an existing write transaction. No-op for an empty list. */
  addIdsTx: TxIdsWrite;
  /** Remove every row for this key (used before deleting the record). */
  clear: (keyId: number) => Promise<void>;
  /** Copy all links from one key to another inside an existing write
   * transaction, so a duplicated record keeps its links atomically. */
  copyLinksTx: (
    tx: TxScope,
    sourceKeyId: number,
    newKeyId: number,
  ) => Promise<void>;
  /** The linked ids for a key, ascending. */
  getIds: (keyId: number) => Promise<number[]>;
  /** Replace a key's linked set with exactly `ids` (deduped): delete the key's
   * rows, then insert the new ones, as a single batch so a failure never
   * leaves a partial set. */
  setIds: (keyId: number, ids: readonly number[]) => Promise<void>;
  /** Like {@link LinkTableSide.setIds} but run on an existing write
   * transaction, so the links commit atomically with the caller's row write. */
  setIdsTx: TxIdsWrite;
};

/** Build the helpers for one direction through a link table. */
export const linkTableSide = (
  table: string,
  keyColumn: string,
  valueColumn: string,
): LinkTableSide => {
  // One multi-row INSERT regardless of id count, so a replace is always two
  // statements and a transactional caller stays clear of the round-trip guard.
  const insertStatement = (
    keyId: number,
    ids: readonly number[],
  ): SqlStatement => ({
    args: ids.flatMap((id) => [keyId, id]),
    sql: `INSERT INTO ${table} (${keyColumn}, ${valueColumn}) VALUES ${ids
      .map(() => "(?, ?)")
      .join(", ")}`,
  });

  // Every link table carries a unique (key, value) index, so repeated ids in a
  // submitted list must collapse to one row each before inserting.
  const dedupe = (ids: readonly number[]): number[] => unique([...ids]);

  const replaceStatements = (
    keyId: number,
    ids: readonly number[],
  ): SqlStatement[] => {
    const deduped = dedupe(ids);
    return [
      { args: [keyId], sql: `DELETE FROM ${table} WHERE ${keyColumn} = ?` },
      ...(deduped.length > 0 ? [insertStatement(keyId, deduped)] : []),
    ];
  };

  return {
    addIdsTx: async (tx, keyId, ids) => {
      const deduped = dedupe(ids);
      if (deduped.length === 0) return;
      await tx.execute(insertStatement(keyId, deduped));
    },
    clear: (keyId) => deleteByField(table, keyColumn, keyId),
    copyLinksTx: async (tx, sourceKeyId, newKeyId) => {
      await tx.execute({
        args: [newKeyId, sourceKeyId],
        sql: `INSERT INTO ${table} (${keyColumn}, ${valueColumn})
              SELECT ?, ${valueColumn} FROM ${table} WHERE ${keyColumn} = ?`,
      });
    },
    getIds: (keyId) =>
      queryIdColumn(
        `SELECT ${valueColumn} AS id FROM ${table} WHERE ${keyColumn} = ? ORDER BY ${valueColumn} ASC`,
        [keyId],
      ),
    setIds: (keyId, ids) => executeBatch(replaceStatements(keyId, ids)),
    setIdsTx: async (tx, keyId, ids) => {
      for (const stmt of replaceStatements(keyId, ids)) {
        await tx.execute(stmt);
      }
    },
  };
};
