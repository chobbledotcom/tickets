/**
 * A "side" is one direction through a link table: `keyColumn` is the record you
 * already have, `valueColumn` is the ids you want. Declare one per direction
 * the module uses.
 *
 * Table and column names are internal constants, never user input.
 *
 * When both columns name the same kind of record, declare the two sides
 * together with {@link selfLinkTableSides}, which answers both directions from
 * one read.
 */

import {
  deleteByField,
  executeBatch,
  inPlaceholders,
  queryAll,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { reduce, requiredMapValue, unique } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { requestBatchCache } from "#shared/request-cache.ts";

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
  /** The linked ids for a key, ascending. An optional transaction reads
   * through it, including the transaction's own earlier writes. */
  getIds: (keyId: number, tx?: TxScope) => Promise<number[]>;
  /** The linked ids for several keys in one bounded query — the
   * {@link ReadIdsByKeys} shape, cache-backed without a transaction and read
   * through it with one. */
  getIdsByKeys: ReadIdsByKeys;
  /** Replace a key's linked set with exactly `ids` (deduped): delete the key's
   * rows, then insert the new ones, as a single batch so a failure never
   * leaves a partial set. */
  setIds: (keyId: number, ids: readonly number[]) => Promise<void>;
  /** Like {@link LinkTableSide.setIds} but run on an existing write
   * transaction, so the links commit atomically with the caller's row write. */
  setIdsTx: TxIdsWrite;
};

/** One direction's reader: its own query, remembered per request. */
const oneDirectionReader = (
  table: string,
  keyColumn: string,
  valueColumn: string,
): ReadIdsByKeys => {
  const fetchIdsByKeys = async (
    keys: number[],
  ): Promise<Map<number, number[]>> => {
    if (keys.length === 0) return new Map();
    const { sql, args } = byKeysStatement(table, keyColumn, valueColumn, keys);
    return rowsToIdsByKeys(keys, await queryAll<LinkRow>(sql, args));
  };

  // Rendering a page asks the same side for overlapping key sets several
  // times, so each key is read from the database once per request. Any write
  // to the table clears what this request remembered.
  const linksByKey = requestBatchCache(fetchIdsByKeys);
  registerTableInvalidation([table], linksByKey.invalidate);
  return (keyIds) => linksByKey.getMany(keyIds);
};

/** Rows of one link table, as the two id columns this module works in. */
type LinkRow = { key_id: number; value_id: number };

/** One side's by-key read as a single statement — the one query both the bare
 * per-request reader and the transaction reader run, so the two cannot drift. */
const byKeysStatement = (
  table: string,
  keyColumn: string,
  valueColumn: string,
  keyIds: readonly number[],
): SqlStatement => ({
  args: [...keyIds],
  sql: `SELECT ${keyColumn} AS key_id, ${valueColumn} AS value_id
          FROM ${table}
         WHERE ${keyColumn} IN (${inPlaceholders(keyIds)})
         ORDER BY ${keyColumn}, ${valueColumn}`,
});

/** Bucket link rows under their key. Every requested key comes back, including
 * keys with no rows, which stay empty lists. */
const rowsToIdsByKeys = (
  keyIds: readonly number[],
  rows: LinkRow[],
): Map<number, number[]> =>
  reduce(
    (acc: Map<number, number[]>, row: LinkRow) => {
      requiredMapValue(acc, row.key_id, "Unexpected link key").push(
        row.value_id,
      );
      return acc;
    },
    new Map(keyIds.map((id) => [id, [] as number[]])),
  )(rows);

/** The linked ids for one key each, keyed by the requested key. */
export type LinkedIdsByKey = Map<number, number[]>;

/** Reads the linked ids for several keys at once. Every key asked for comes
 * back, including keys with no links. An optional transaction reads the same
 * query through it, so a caller inside a write transaction sees its own
 * earlier writes instead of the per-request cache. */
type ReadIdsByKeys = (
  keyIds: readonly number[],
  tx?: TxScope,
) => Promise<LinkedIdsByKey>;

/** Build the helpers for one direction through a link table. */
export const linkTableSide = (
  table: string,
  keyColumn: string,
  valueColumn: string,
  readIdsByKeys: ReadIdsByKeys = oneDirectionReader(
    table,
    keyColumn,
    valueColumn,
  ),
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

  const linkSide: LinkTableSide = {
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
    getIds: async (keyId, tx?) =>
      requiredMapValue(
        await linkSide.getIdsByKeys([keyId], tx),
        keyId,
        `Missing link result for ${keyColumn} ${keyId}`,
      ),
    getIdsByKeys: async (keyIds, tx?) => {
      if (tx === undefined) return readIdsByKeys(keyIds);
      if (keyIds.length === 0) return new Map();
      return rowsToIdsByKeys(
        keyIds,
        resultRows<LinkRow>(
          await tx.execute(
            byKeysStatement(table, keyColumn, valueColumn, keyIds),
          ),
        ),
      );
    },
    setIds: (keyId, ids) => executeBatch(replaceStatements(keyId, ids)),
    setIdsTx: async (tx, keyId, ids) => {
      await tx.batch(replaceStatements(keyId, ids));
    },
  };
  return linkSide;
};

/** What one record links to, both ways round, when a link table joins a kind of
 * record to itself. */
type BothDirections = { pointsAt: number[]; pointedAtBy: number[] };

/** The two directions through a link table that joins a kind of record to
 * itself. */
export type SelfLinkTableSides = {
  /** Keyed by the `keyColumn` record: the `valueColumn` ids it points at. */
  pointsAt: LinkTableSide;
  /** Keyed by the `valueColumn` record: the `keyColumn` ids pointing at it. */
  pointedAtBy: LinkTableSide;
};

const emptyBothDirections = (
  ids: readonly number[],
): Map<number, BothDirections> =>
  new Map(ids.map((id) => [id, { pointedAtBy: [], pointsAt: [] }]));

/**
 * Both directions through a link table whose two columns name the same kind of
 * record — a listing's children and the parents it sits under.
 *
 * Both sides share one read and one memory of it, so asking each way round for
 * the same records costs one round trip rather than two. Rows come back ordered
 * by key then value, which leaves every list here ascending.
 */
export const selfLinkTableSides = (
  table: string,
  keyColumn: string,
  valueColumn: string,
): SelfLinkTableSides => {
  const fetchBothDirections = async (
    ids: number[],
  ): Promise<Map<number, BothDirections>> => {
    const linksById = emptyBothDirections(ids);
    if (ids.length === 0) return linksById;
    // Both directions read the same ids, so the list is bound once and its
    // slots appear under both columns.
    const { sql, args } = numberedStatement((bind) => {
      const idSlots = ids.map(bind).join(", ");
      return `${keyColumn} IN (${idSlots}) OR ${valueColumn} IN (${idSlots})`;
    });
    const rows = await queryAll<LinkRow>(
      `SELECT ${keyColumn} AS key_id, ${valueColumn} AS value_id
         FROM ${table}
        WHERE ${sql}
        ORDER BY ${keyColumn}, ${valueColumn}`,
      args,
    );
    for (const { key_id, value_id } of rows) {
      // A row matched on either column, so only one of its two records has to
      // be one the caller asked about.
      linksById.get(key_id)?.pointsAt.push(value_id);
      linksById.get(value_id)?.pointedAtBy.push(key_id);
    }
    return linksById;
  };

  const linksById = requestBatchCache(fetchBothDirections);
  registerTableInvalidation([table], linksById.invalidate);

  const directionReader =
    (direction: keyof BothDirections): ReadIdsByKeys =>
    async (keyIds) =>
      new Map(
        [...(await linksById.getMany(keyIds))].map(([id, links]) => [
          id,
          links[direction],
        ]),
      );

  return {
    pointedAtBy: linkTableSide(
      table,
      valueColumn,
      keyColumn,
      directionReader("pointedAtBy"),
    ),
    pointsAt: linkTableSide(
      table,
      keyColumn,
      valueColumn,
      directionReader("pointsAt"),
    ),
  };
};
