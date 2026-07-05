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
  queryAll,
  resultRows,
  type SqlStatement,
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

/** Turn a database row into the {@link Transfer} the rest of the code uses.
 *  A kindless leg is stored as `kind = ''` (see {@link legColumns}); it maps
 *  back to an *omitted* `kind`, mirroring `reverses_id`, so a stored transfer
 *  and a never-stored {@link TransferInput} agree on what "no kind" looks like. */
const rowToTransfer = (row: TransferRow): Transfer => ({
  amount: Number(row.amount),
  destination: account(row.dest_type, row.dest_id),
  eventGroup: row.event_group,
  id: Number(row.id),
  ...(row.kind === "" ? {} : { kind: row.kind }),
  memo: row.memo,
  occurredAt: epochMsToIso(Number(row.occurred_at)),
  postedBy: row.posted_by,
  recordedAt: epochMsToIso(Number(row.recorded_at)),
  reference: row.reference,
  ...(row.reverses_id === null ? {} : { reversesId: Number(row.reverses_id) }),
  source: account(row.source_type, row.source_id),
});

/** One column of a transfers INSERT: its name, the SQL placeholder/expression
 *  for its value, and the args that expression binds. */
type LegColumn = { col: string; expr: string; args: InValue[] };

/** A built statement ready for `execute`/`executeBatch`. */

/** A plain bound-placeholder column. */
const lit = (col: string, value: InValue): LegColumn => ({
  args: [value],
  col,
  expr: "?",
});

/** Renders one leg side's account id column. The default binds the id as a
 *  literal; the batch booking writer swaps in its in-batch subquery for the
 *  attendee side ({@link bookingLegBatchInsert}). */
type AccountIdColumn = (col: string, acct: AccountRef) => LegColumn;

const literalId: AccountIdColumn = (col, acct) => lit(col, acct.id);

/**
 * The column→value plan for one transfers row, in a fixed order — the single
 * place the table's INSERT columns and defaults live. Every insert variant
 * (plain, `OR IGNORE`, guarded, batch-booking) renders from this one plan via
 * {@link renderInsert}, so a new column — or a changed default — is written
 * exactly once and can never drift between the write paths.
 */
const legColumns = (
  t: TransferInput,
  recordedAt: string,
  idCol: AccountIdColumn = literalId,
): LegColumn[] => [
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

/**
 * Render the INSERT for a column plan. Without a guard it is a plain
 * `VALUES (…)` insert; with one, the values become `SELECT … WHERE <guard>` so
 * the row lands only while the guard still holds — one statement either way,
 * so it can ride in a single batch. Each column keeps its own placeholder (the
 * guard's args are appended after the columns'), so a stray `$`/`?` in the
 * guard SQL can never re-bind a column value.
 */
const renderInsert = (
  columns: LegColumn[],
  guard?: { sql: string; args: InValue[] },
): SqlStatement => {
  const exprs = columns.map((column) => column.expr).join(", ");
  return {
    args: [...columns.flatMap((column) => column.args), ...(guard?.args ?? [])],
    sql:
      `INSERT INTO transfers (${columns.map((column) => column.col).join(", ")}) ` +
      (guard ? `SELECT ${exprs} WHERE ${guard.sql}` : `VALUES (${exprs})`),
  };
};

/** Build the INSERT for one transfer. `recordedAt` is the write-time clock. */
export const insertStatement = (
  t: TransferInput,
  recordedAt: string,
): SqlStatement => renderInsert(legColumns(t, recordedAt));

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
 * Renders from the shared {@link legColumns} plan.
 */
export const guardedInsertStatement = (
  t: TransferInput,
  recordedAt: string,
  guardSql: string,
  guardArgs: InValue[],
): SqlStatement =>
  renderInsert(legColumns(t, recordedAt), { args: guardArgs, sql: guardSql });

/**
 * Build an idempotent, guarded INSERT for one booking leg, for the single-batch
 * booking writer. `INSERT OR IGNORE` keys idempotency on the unique `reference`
 * (a replay re-derives identical references and is skipped); whichever side
 * (source/dest) is the attendee account renders its id via `attendeeIdSql` (the
 * in-batch `MAX(id)` subquery over the just-inserted attendee) instead of a
 * literal, so the leg can be written before the attendee row's id is known; and
 * the row lands only while `guard` holds (the whole booking landed). No
 * interleaved read is needed — the conflict checks the interactive path does
 * inline are unnecessary for a fresh booking whose references are new. */
export const bookingLegBatchInsert = (
  t: TransferInput,
  recordedAt: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  guard: { sql: string; args: InValue[] },
): SqlStatement =>
  orIgnore(
    renderInsert(
      legColumns(t, recordedAt, (col, acct) =>
        acct.type === ATTENDEE
          ? {
              args: [attendeeIdArg],
              col,
              expr: `CAST(${attendeeIdSql} AS TEXT)`,
            }
          : literalId(col, acct),
      ),
      guard,
    ),
  );

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

/** The stored transfer with this id, or null when none exists. */
export const selectById = async (
  read: RowReader,
  id: number,
): Promise<Transfer | null> =>
  (await selectTransfers(read, " WHERE id = ?", [id]))[0] ?? null;
