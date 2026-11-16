/**
 * Shared SQL plumbing for the transfers ledger.
 *
 * This module is the only place that knows the table's columns and how a stored
 * row maps to a {@link Transfer}. Both the write path ({@link file://./store.ts})
 * and the read queries ({@link file://./queries.ts}) build on the small readers
 * here. The column list and row mapping therefore live in exactly one place.
 */

import type { ResultSet } from "@libsql/client";
import { ATTENDEE } from "#accounting/accounts.ts";
import { type BatchExecutor, resultRows } from "#db/client.ts";
import { among, named, type Operand, valued } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node, Query } from "#db/select/shape.ts";
import { type RowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { type InsertOptions, insertInto, type NewValues } from "#db/write.ts";
import { bindFirst } from "#shared/fp-bind.ts";
import { account } from "#shared/ledger/account.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  epochMsToIso,
  instantToEpochMs,
} from "#shared/validation/timestamp.ts";

/** The two account endpoints of a stored transfers row: the account the money
 * left (`source_*`) and the account it entered (`dest_*`). Shared with the
 * narrow cost-row reads that only need to know which side is which. */
export type TransferEndpoints = {
  source_type: string;
  source_id: string;
  dest_type: string;
  dest_id: string;
};

/** One row of the transfers table, as the database returns it. */
type TransferRow = TransferEndpoints & {
  id: number | bigint;
  amount: number | bigint;
  occurred_at: number | bigint;
  recorded_at: number | bigint;
  reference: string;
  event_group: string;
  kind: string;
  memo: string;
  reverses_id: number | bigint | null;
  reverses_group: string;
  posted_by: string;
};

const COLUMNS = sql`id, source_type, source_id, dest_type, dest_id, amount, occurred_at, recorded_at, reference, event_group, kind, memo, reverses_id, reverses_group, posted_by`;

/** Turn a database row into the {@link Transfer} the rest of the code uses.
 *  A kindless leg is stored as `kind = ''` (see {@link legRow}). It maps
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
  ...(row.reverses_group === "" ? {} : { reversesGroup: row.reverses_group }),
  source: account(row.source_type, row.source_id),
});

/** Gives one leg side's account id. The default binds the id. The batch
 *  booking writer swaps in its in-batch subquery for the attendee side
 *  ({@link bookingLegBatchInsert}). */
type AccountIdOf = (acct: AccountRef) => Operand<string>;

const literalId: AccountIdOf = (acct) => acct.id;

/**
 * The new transfers row for one leg — the single place the table's INSERT
 * columns and defaults live. Every insert variant (plain, `OR IGNORE`,
 * guarded, batch-booking) writes this one row. A new column — or a changed
 * default — is then written exactly once and can never drift between the
 * write paths.
 */
const legRow = (
  t: TransferInput,
  recordedAt: string,
  idOf: AccountIdOf = literalId,
): NewValues<"transfers"> => ({
  amount: t.amount,
  dest_id: idOf(t.destination),
  dest_type: t.destination.type,
  event_group: t.eventGroup,
  kind: t.kind ?? "",
  memo: t.memo ?? "",
  occurred_at: instantToEpochMs(t.occurredAt),
  posted_by: t.postedBy ?? "system",
  recorded_at: instantToEpochMs(recordedAt),
  reference: t.reference,
  reverses_group: t.reversesGroup ?? "",
  reverses_id: t.reversesId ?? null,
  source_id: idOf(t.source),
  source_type: t.source.type,
});

/** Insert one leg row. With a guard the values become `SELECT … WHERE
 *  <guard>`, so the row lands only while the guard still holds. One statement
 *  either way, so it can ride in a single batch. */
const insertLeg = (
  options: InsertOptions<"transfers">,
  row: NewValues<"transfers">,
  guard: SqlStatement | undefined,
): SqlStatement =>
  insertInto(
    tables.transfers,
    row,
    guard === undefined ? options : { ...options, when: valued(guard) },
  );

const INSERT: InsertOptions<"transfers"> = {};
const INSERT_IF_NEW: InsertOptions<"transfers"> = { or: "IGNORE" };

/** The INSERT for one transfer under one set of insert options. `recordedAt`
 * is the write-time clock. With a guard the leg lands only while the guard
 * holds, so the leg can ride in a one-shot batch. */
const insertUnder = (
  options: InsertOptions<"transfers">,
  t: TransferInput,
  recordedAt: string,
  guard?: SqlStatement,
): SqlStatement => insertLeg(options, legRow(t, recordedAt), guard);

/** Build the INSERT for one transfer. The settle batch passes a guard to post
 * a balance-payment leg atomically. That batch stays a batch, not an
 * interactive transaction, for its concurrency guard. */
export const insertStatement = bindFirst(insertUnder)(INSERT);

/** {@link insertStatement}, dropping a leg whose unique `reference` is
 * already stored: a replayed write re-derives the same reference and lands
 * nowhere. */
export const insertIfNewStatement = bindFirst(insertUnder)(INSERT_IF_NEW);

/** One insert-if-new statement for each leg, all recorded at one time. */
export const insertIfNewStatements = (
  legs: readonly Parameters<typeof insertIfNewStatement>[0][],
  recordedAt: string,
): SqlStatement[] => legs.map((leg) => insertIfNewStatement(leg, recordedAt));

/**
 * Build an idempotent, guarded INSERT for one booking leg, for the single-batch
 * booking writer. `INSERT OR IGNORE` keys idempotency on the unique `reference`
 * (a replay re-derives identical references and is skipped). Whichever side
 * (source/dest) is the attendee account renders its id via `attendeeIdSql` (the
 * in-batch `MAX(id)` subquery over the just-inserted attendee) instead of a
 * literal. The leg can then be written before the attendee row's id is known.
 * The row lands only while `guard` holds (the whole booking landed). No
 * interleaved read is needed — the conflict checks the interactive path does
 * inline are unnecessary for a fresh booking whose references are new. */
export const bookingLegBatchInsert = (
  t: TransferInput,
  recordedAt: string,
  attendeeIdSql: SqlStatement,
  guard: SqlStatement,
): SqlStatement =>
  insertLeg(
    INSERT_IF_NEW,
    legRow(t, recordedAt, (acct) =>
      acct.type === ATTENDEE
        ? valued(sql`CAST(${attendeeIdSql} AS TEXT)`)
        : literalId(acct),
    ),
    guard,
  );

/** The transfers held by one answered query. */
const transfersIn = (result: ResultSet): Transfer[] =>
  resultRows<TransferRow>(result).map(rowToTransfer);

/** A read of the ledger, before it names its columns. */
type LedgerRead = Query<Node<"transfers">>;

/** Which transfers to read, in what order, how many: the ledger read with its
 * conditions, its order and its limit. A transfer read always knows the
 * columns and the table. */
export type TransferRead = (ledger: LedgerRead) => LedgerRead;

const everyTransfer: TransferRead = (ledger) => ledger;

/** Wants every transfer whose `column` is one of `values`. An empty list asks
 *  for nothing, and is answered without a round trip. */
export const byColumnIn =
  (
    column: keyof RowOf<"transfers">,
    values: readonly (string | number)[],
  ): TransferRead =>
  (ledger) =>
    ledger.where(() => among(named(column), values));

const transferStatement = (read: LedgerRead): SqlStatement =>
  read.columns(() => COLUMNS);

/** One set of rows for each query, in the order the queries were given. A
 *  caller can then name them by destructuring rather than counting positions. */
type TransfersPerQuery<Queries extends readonly TransferRead[]> = {
  [Index in keyof Queries]: Transfer[];
};

/** Select several sets of transfers at once, in one round trip. Each set names
 * the rows it wants and their order instead of the SQL. `read` decides where
 * the rows come from: the client's `queryBatch`, or an open transaction's own
 * `batch`. The write path reads through its transaction, so the write lock
 * makes two posters of one event take turns. A query that can match no row is
 * answered as empty without a trip to the database. */
export const selectTransfersMany = async <
  const Queries extends readonly TransferRead[],
>(
  read: BatchExecutor,
  queries: Queries,
): Promise<TransfersPerQuery<Queries>> => {
  const asked = queries
    .map((query, index) => ({ index, query: query(from(tables.transfers)) }))
    .filter(({ query }) => !query.matchesNothing());
  const answers =
    asked.length === 0
      ? []
      : await read(asked.map(({ query }) => transferStatement(query)));
  const rowsByQuery = new Map(
    asked.map(({ index }, position) => [
      index,
      transfersIn(
        requireValue(answers[position], `Ledger read ${index} went unanswered`),
      ),
    ]),
  );
  // Built by mapping the queries, so it is one set per query by construction.
  // A query left out of the bundle is one no input can match.
  return queries.map(
    (_, index) => rowsByQuery.get(index) ?? [],
  ) as TransfersPerQuery<Queries>;
};

/** Select transfers, saying which rows and in what order rather than writing
 * the query. Pass nothing to read the whole table. */
export const selectTransfers = async (
  read: BatchExecutor,
  query: TransferRead = everyTransfer,
): Promise<Transfer[]> => {
  const [rows] = await selectTransfersMany(read, [query]);
  return rows;
};

/** Read transfers whose rows a WHERE condition selects. The condition reads
 *  the ledger row as `transfer`. */
export const selectTransfersScope = async (
  read: BatchExecutor,
  where: SqlStatement,
): Promise<Transfer[]> => {
  const [result] = await read([
    sql`SELECT ${COLUMNS} FROM transfers AS transfer WHERE ${where}`,
  ]);
  return transfersIn(requireValue(result, "Ledger read went unanswered"));
};

/** Every leg of one business event (booking, refund, …). */
export const selectByEventGroup = (
  read: BatchExecutor,
  eventGroup: string,
): Promise<Transfer[]> =>
  selectTransfers(read, byColumnIn("event_group", [eventGroup]));

/** The stored transfer with this id, or null when none exists. */
export const selectById = async (
  read: BatchExecutor,
  id: number,
): Promise<Transfer | null> =>
  (await selectTransfers(read, byColumnIn("id", [id])))[0] ?? null;
