/**
 * Shared SQL plumbing for the transfers ledger.
 *
 * This module is the only place that knows the table's columns and how a stored
 * row maps to a {@link Transfer}. Both the write path ({@link file://./store.ts})
 * and the read queries ({@link file://./queries.ts}) build on the small readers
 * here, so the column list and row mapping live in exactly one place.
 */

import type { InValue } from "@libsql/client";
import {
  inPlaceholders,
  insert,
  queryAll,
  resultRows,
  type TxScope,
} from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";

/** One row of the transfers table, as the database returns it. */
type TransferRow = {
  id: number | bigint;
  source_type: string;
  source_id: string;
  dest_type: string;
  dest_id: string;
  amount: number | bigint;
  currency: string;
  occurred_at: string;
  recorded_at: string;
  reference: string;
  event_group: string;
  kind: string;
  memo: string;
  reverses_id: number | bigint | null;
  posted_by: string;
};

const COLUMNS =
  "id, source_type, source_id, dest_type, dest_id, amount, currency, " +
  "occurred_at, recorded_at, reference, event_group, kind, memo, " +
  "reverses_id, posted_by";

/** Turn a database row into the {@link Transfer} the rest of the code uses. */
const rowToTransfer = (row: TransferRow): Transfer => ({
  amount: Number(row.amount),
  currency: row.currency,
  destination: account(row.dest_type, row.dest_id),
  eventGroup: row.event_group,
  id: Number(row.id),
  kind: row.kind,
  memo: row.memo,
  occurredAt: row.occurred_at,
  postedBy: row.posted_by,
  recordedAt: row.recorded_at,
  reference: row.reference,
  reversesId: row.reverses_id === null ? undefined : Number(row.reverses_id),
  source: account(row.source_type, row.source_id),
});

/** Build the INSERT for one transfer. `recordedAt` is the write-time clock. */
export const insertStatement = (
  t: TransferInput,
  recordedAt: string,
): { sql: string; args: InValue[] } =>
  insert("transfers", {
    amount: t.amount,
    currency: t.currency,
    dest_id: t.destination.id,
    dest_type: t.destination.type,
    event_group: t.eventGroup,
    kind: t.kind ?? "",
    memo: t.memo ?? "",
    occurred_at: t.occurredAt,
    posted_by: t.postedBy ?? "system",
    recorded_at: recordedAt,
    reference: t.reference,
    reverses_id: t.reversesId ?? null,
    source_id: t.source.id,
    source_type: t.source.type,
  });

/**
 * A guarded INSERT for one transfer: `INSERT … SELECT … WHERE <guard>`, so a leg
 * can be folded into a one-shot batch and land only when the guard still holds.
 * Used to post a balance-payment leg atomically inside the settle batch (which
 * stays a batch, not an interactive transaction, for its concurrency guard).
 * Reuses {@link insertStatement} so the column list is never duplicated.
 */
export const guardedInsertStatement = (
  t: TransferInput,
  recordedAt: string,
  guardSql: string,
  guardArgs: InValue[],
): { sql: string; args: InValue[] } => {
  const base = insertStatement(t, recordedAt);
  return {
    args: [...base.args, ...guardArgs],
    sql: base.sql.replace(/VALUES \(([^)]*)\)/, `SELECT $1 WHERE ${guardSql}`),
  };
};

/**
 * Reads rows either from the global client or from an open transaction. The
 * write path reads through its own transaction: the database write lock then
 * makes concurrent posters of the same event take turns, so the second one sees
 * the first one's rows and replays instead of double-posting.
 */
export type RowReader = (
  sql: string,
  args: InValue[],
) => Promise<TransferRow[]>;

export const fromDb: RowReader = (sql, args) =>
  queryAll<TransferRow>(sql, args);

export const fromTx =
  (tx: TxScope): RowReader =>
  async (sql, args) =>
    resultRows<TransferRow>(await tx.execute({ args, sql }));

/** Select transfers matching a WHERE clause (pass "" for the whole table). */
export const selectTransfers = async (
  read: RowReader,
  where: string,
  args: InValue[],
): Promise<Transfer[]> => {
  const rows = await read(`SELECT ${COLUMNS} FROM transfers${where}`, args);
  return rows.map(rowToTransfer);
};

/** Every leg of one business event (booking, refund, …). */
export const selectByEventGroup = (
  read: RowReader,
  eventGroup: string,
): Promise<Transfer[]> =>
  selectTransfers(read, " WHERE event_group = ?", [eventGroup]);

/** The stored transfers among the given references — used to spot a reference
 *  that already belongs to a different event before inserting. */
export const selectByReferences = (
  read: RowReader,
  references: string[],
): Promise<Transfer[]> =>
  selectTransfers(
    read,
    ` WHERE reference IN (${inPlaceholders(references)})`,
    references,
  );

/** The single currency the ledger already holds, or null when it is empty. The
 *  first post sets it; later posts must match. */
export const ledgerCurrency = async (
  read: RowReader,
): Promise<string | null> => {
  const rows = await read("SELECT currency FROM transfers LIMIT 1", []);
  return rows[0]?.currency ?? null;
};

/** The stored transfer with this id, or null when none exists. */
export const selectById = async (
  read: RowReader,
  id: number,
): Promise<Transfer | null> =>
  (await selectTransfers(read, " WHERE id = ?", [id]))[0] ?? null;
