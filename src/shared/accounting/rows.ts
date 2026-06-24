/**
 * Shared SQL plumbing for the transfers ledger.
 *
 * This module is the only place that knows the table's columns and how a stored
 * row maps to a {@link Transfer}. Both the write path ({@link file://./store.ts})
 * and the read queries ({@link file://./queries.ts}) build on the small readers
 * here, so the column list and row mapping live in exactly one place.
 */

import type { InValue } from "@libsql/client";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import {
  inPlaceholders,
  insert,
  queryAll,
  resultRows,
  type TxScope,
} from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";
import {
  epochMsToIso,
  instantToEpochMs,
} from "#shared/validation/timestamp.ts";

/** One row of the transfers table, as the database returns it. */
type TransferRow = {
  id: number | bigint;
  source_type: string;
  source_id: string;
  dest_type: string;
  dest_id: string;
  amount: number | bigint;
  occurred_at: number | bigint;
  recorded_at: number | bigint;
  reference: string;
  event_group: string;
  kind: string;
  memo: string;
  reverses_id: number | bigint | null;
  posted_by: string;
};

const COLUMNS =
  "id, source_type, source_id, dest_type, dest_id, amount, " +
  "occurred_at, recorded_at, reference, event_group, kind, memo, " +
  "reverses_id, posted_by";

/** Turn a database row into the {@link Transfer} the rest of the code uses. */
const rowToTransfer = (row: TransferRow): Transfer => ({
  amount: Number(row.amount),
  destination: account(row.dest_type, row.dest_id),
  eventGroup: row.event_group,
  id: Number(row.id),
  kind: row.kind,
  memo: row.memo,
  occurredAt: epochMsToIso(Number(row.occurred_at)),
  postedBy: row.posted_by,
  recordedAt: epochMsToIso(Number(row.recorded_at)),
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
    dest_id: t.destination.id,
    dest_type: t.destination.type,
    event_group: t.eventGroup,
    kind: t.kind ?? "",
    memo: t.memo ?? "",
    occurred_at: instantToEpochMs(t.occurredAt),
    posted_by: t.postedBy ?? "system",
    recorded_at: instantToEpochMs(recordedAt),
    reference: t.reference,
    reverses_id: t.reversesId ?? null,
    source_id: t.source.id,
    source_type: t.source.type,
  });

/**
 * Rewrite a built transfer INSERT as `INSERT OR IGNORE`, so a leg whose unique
 * `reference` is already stored is dropped rather than raising a constraint
 * error. The one-shot backfill wraps {@link insertStatement} with this for
 * idempotency: a re-run re-derives the same references and the duplicates are
 * skipped. Takes the built statement (not the columns) so the column list still
 * lives only in {@link insertStatement}.
 */
export const orIgnore = (statement: {
  sql: string;
  args: InValue[];
}): { sql: string; args: InValue[] } => ({
  args: statement.args,
  sql: statement.sql.replace(/^INSERT INTO/, "INSERT OR IGNORE INTO"),
});

/**
 * A guarded INSERT for one transfer: `INSERT … SELECT … WHERE <guard>`, so a leg
 * can be folded into a one-shot batch and land only when the guard still holds.
 * Used to post a balance-payment leg atomically inside the settle batch (which
 * stays a batch, not an interactive transaction, for its concurrency guard).
 * Reuses {@link insertStatement} so the column list is never duplicated.
 *
 * The placeholder list captured from `VALUES (…)` is carried straight into the
 * `SELECT …` via the replacer function (not a `$1` string token), so every
 * column keeps its own placeholder and a stray `$` in `guardSql` is harmless.
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
    sql: base.sql.replace(
      /VALUES \(([^)]*)\)/,
      (_, placeholders: string) => `SELECT ${placeholders} WHERE ${guardSql}`,
    ),
  };
};

/** One column of a transfers INSERT: its name, the SQL placeholder/expression
 *  for its value, and the args that expression binds. */
type LegColumn = { col: string; expr: string; args: InValue[] };

/**
 * The column→value plan for one transfer leg, in a fixed order. When
 * `attendeeId` is given, whichever side (source/dest) is the attendee account
 * renders its id via that SQL expression (the in-batch `MAX(id)` subquery)
 * instead of a literal — so a leg can be written before the attendee row's id is
 * known, in the same batch that inserts it. With `attendeeId` null every id is a
 * literal. The one place a transfer's columns, ordering, and defaults live for
 * the batch writer. */
const legColumns = (
  t: TransferInput,
  recordedAt: string,
  attendeeId: { sql: string; args: InValue[] } | null,
): LegColumn[] => {
  const idCol = (col: string, acct: AccountRef): LegColumn =>
    attendeeId && acct.type === ATTENDEE
      ? { args: attendeeId.args, col, expr: `CAST(${attendeeId.sql} AS TEXT)` }
      : { args: [acct.id], col, expr: "?" };
  const lit = (col: string, value: InValue): LegColumn => ({
    args: [value],
    col,
    expr: "?",
  });
  return [
    lit("source_type", t.source.type),
    idCol("source_id", t.source),
    lit("dest_type", t.destination.type),
    idCol("dest_id", t.destination),
    lit("amount", t.amount),
    lit("occurred_at", instantToEpochMs(t.occurredAt)),
    lit("recorded_at", instantToEpochMs(recordedAt)),
    lit("reference", t.reference),
    lit("event_group", t.eventGroup),
    lit("kind", t.kind ?? ""),
    lit("memo", t.memo ?? ""),
    lit("reverses_id", t.reversesId ?? null),
    lit("posted_by", t.postedBy ?? "system"),
  ];
};

/**
 * Build an idempotent, guarded INSERT for one booking leg, for the single-batch
 * booking writer. `INSERT OR IGNORE` keys idempotency on the unique `reference`
 * (a replay re-derives identical references and is skipped), the attendee
 * account id is resolved by `attendeeIdSql` (the `MAX(id)` subquery over the
 * just-inserted attendee), and the row lands only while `guard` holds (the whole
 * booking landed). No interleaved read is needed — the conflict checks the
 * interactive path does inline are unnecessary for a fresh booking whose
 * references are new. */
export const bookingLegBatchInsert = (
  t: TransferInput,
  recordedAt: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  guard: { sql: string; args: InValue[] },
): { sql: string; args: InValue[] } => {
  const columns = legColumns(t, recordedAt, {
    args: [attendeeIdArg],
    sql: attendeeIdSql,
  });
  return {
    args: [...columns.flatMap((c) => c.args), ...guard.args],
    sql: `INSERT OR IGNORE INTO transfers (${columns
      .map((c) => c.col)
      .join(", ")})
        SELECT ${columns.map((c) => c.expr).join(", ")}
        WHERE ${guard.sql}`,
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

/** The stored transfer with this id, or null when none exists. */
export const selectById = async (
  read: RowReader,
  id: number,
): Promise<Transfer | null> =>
  (await selectTransfers(read, " WHERE id = ?", [id]))[0] ?? null;
