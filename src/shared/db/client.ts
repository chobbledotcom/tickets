/**
 * Database client setup and core utilities.
 *
 * The low-level runners here record every statement for the query log, so a
 * helper built on them is timed and counted without asking.
 */

import type {
  Client,
  InStatement,
  InValue,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";
import { createDatabaseClient } from "#db/database-client.ts";
import { classifyDatabaseError, DATABASE_RETRY } from "#db/errors.ts";
import {
  beginTransaction,
  type TransactionOperation,
  wrapExecute,
  wrapTransactionOperations,
} from "#db/libsql-call.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import {
  countDatabaseRoundTrip,
  enforceTransactionRoundTripGuard,
  trackSql,
} from "#db/query-log.ts";
import {
  type SqlSlot,
  type SqlStatement,
  sql,
  sqlCommas,
  sqlJoin,
  sqlName,
  sqlNames,
} from "#db/sql.ts";
import { isReadSql, sqlOf, writeSqlOf } from "#db/sql-text.ts";
import { trackedTxBatch, trackedTxExecute } from "#db/tracked-transaction.ts";
import { lazyRef } from "#fp";
import { invalidateCachesForWrite } from "#shared/cache-registry.ts";
import { getEnv } from "#shared/env.ts";
import { namedError } from "#shared/named-error.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import { withSubrequestReserve } from "#shared/subrequest-budget.ts";
import { topLevelCommas } from "#shared/top-level-commas.ts";

/**
 * Match the target table of a mutating statement (INSERT/UPDATE/DELETE/REPLACE),
 * the mirror of query-log's read detector. Anchored at the start so it fails
 * fast on the SELECTs that dominate the call volume. The optional
 * `OR <action>` / `OR <action> INTO` clauses cover libsql's conflict variants.
 */
const WRITE_TABLE_RE =
  /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`]?(\w+)/i;

/**
 * The lower-cased column names an UPDATE's SET clause assigns, or null when none
 * can be read. Commas inside parentheses are skipped, so a `coalesce(x, 0)` does
 * not split one assignment into two. Null means the caller invalidates
 * unconditionally — safe over stale.
 */
export const extractUpdateColumns = (
  sql: string,
): ReadonlySet<string> | null => {
  const setMatch = /\bSET\s+([\s\S]*?)(?:\s+WHERE\b|$)/i.exec(sql);
  if (!setMatch) return null;
  const setClause = setMatch[1]!.trim();
  const columns = new Set<string>();
  const addAssignment = (frag: string): void => {
    const eqIdx = frag.indexOf("=");
    if (eqIdx < 0) return;
    const col = frag
      .slice(0, eqIdx)
      .trim()
      .split(".")
      .pop()!
      .replace(/["`[\]]/g, "")
      .toLowerCase();
    if (col) columns.add(col);
  };
  let start = 0;
  const { commas } = topLevelCommas(setClause, {
    closers: ")",
    openers: "(",
    // A quoted SQL value is opaque: its brackets and commas split nothing.
    quotes: "'\"",
    start: 0,
    stopWhenClosed: false,
  });
  for (const comma of [...commas, setClause.length]) {
    addAssignment(setClause.slice(start, comma).trim());
    start = comma + 1;
  }
  return columns.size > 0 ? columns : null;
};

/**
 * After a successful write, invalidate every cache that declared a dependency on
 * the mutated table; a no-op for reads and for tables nothing depends on. An
 * UPDATE is narrowed by its SET columns, so a dependency gated on
 * `quantity`/`price_paid`/`listing_id` survives a write that touches none of
 * them. Columns that cannot be read mean invalidating anyway — safe over stale.
 */
const invalidateForSql = (sql: string): void => {
  const writeSql = writeSqlOf(sql);
  const match = WRITE_TABLE_RE.exec(writeSql);
  if (!match) return;
  const table = match[1]!.toLowerCase();
  const firstWord = writeSql.trimStart().split(/\s/)[0]!.toLowerCase();
  // Only an UPDATE is narrowed by what it assigns. Every other write, and an
  // UPDATE whose SET clause cannot be read, invalidates unconditionally.
  invalidateCachesForWrite(table, {
    updatedColumns:
      firstWord === "update" ? extractUpdateColumns(writeSql) : null,
  });
};

const createDbClient = (): Client => {
  const url = getEnv("DB_URL");
  if (!url) {
    throw new Error("DB_URL environment variable is required");
  }
  // libsql's Config types authToken as `authToken?: string`, which under
  // exactOptionalPropertyTypes rejects an explicit `undefined`. A no-token
  // client is valid at runtime, so assert the type rather than branch on it
  // (a branch here leaves one side uncovered).
  return createDatabaseClient({
    authToken: getEnv("DB_TOKEN"),
    url,
  } as Parameters<typeof createDatabaseClient>[0]);
};

const GUARDED_CLIENT = Symbol("guarded-db-client");

const databaseRoundTrip = <T>(
  operation: string,
  run: () => T,
  enforceBudget = true,
): T => {
  countDatabaseRoundTrip(operation, enforceBudget);
  return run();
};

type AroundExecute = Parameters<typeof wrapExecute>[1];

const executeWithRoundTrip =
  (around: AroundExecute) =>
  (target: Pick<Client, "execute">, operation: string) =>
    wrapExecute(target, (statement, execute) =>
      around(statement, () => databaseRoundTrip(operation, execute)),
    );

/** Count and retry a bare client statement. Transaction statements use only the
 * round-trip guard above: the transaction runner owns the retry decision. */
const executeWithTransientRetry = executeWithRoundTrip((statement, execute) =>
  retryOnTransientDatabaseError(execute, {
    isRead: isReadSql(sqlOf(statement)),
  }),
);

/** The subrequest-budget label each interactive transaction operation counts
 * against. */
const TRANSACTION_OPERATION: Record<TransactionOperation, string> = {
  batch: "transaction batch",
  commit: "transaction commit",
  execute: "transaction statement",
  executeMultiple: "transaction script",
  rollback: "transaction rollback",
};

const transactionWithRoundTripGuard = (transaction: Transaction): Transaction =>
  wrapTransactionOperations(transaction, (operation, run) =>
    // Rollback is mandatory cleanup: an interactive transaction left open (its
    // rollback blocked) poisons the shared write connection for the rest of the
    // request. It is counted like any other subrequest — so the running total
    // stays accurate for later calls — but never blocked, so it always runs even
    // once the budget is spent.
    databaseRoundTrip(
      TRANSACTION_OPERATION[operation],
      run,
      operation !== "rollback",
    ),
  );

const guardedClients = new WeakMap<Client, Client>();

const withRoundTripGuard = (client: Client): Client => {
  if (Reflect.get(client, GUARDED_CLIENT) === true) return client;
  const existing = guardedClients.get(client);
  if (existing) return existing;
  const guarded = proxyMembers(client, {
    [GUARDED_CLIENT]: true,
    batch: (statements: InStatement[], mode?: TransactionMode) =>
      databaseRoundTrip("batch", () => client.batch(statements, mode)),
    execute: executeWithTransientRetry(client, "statement"),
    executeMultiple: (sql: string): Promise<void> =>
      databaseRoundTrip("script", () => client.executeMultiple(sql)),
    migrate: (statements: InStatement[]): Promise<ResultSet[]> =>
      databaseRoundTrip("migration batch", () => client.migrate(statements)),
    sync: () => databaseRoundTrip("replica sync", () => client.sync()),
    transaction: async (mode?: TransactionMode): Promise<Transaction> =>
      transactionWithRoundTripGuard(
        await databaseRoundTrip("transaction begin", () =>
          beginTransaction(client, mode),
        ),
      ),
  });
  guardedClients.set(client, guarded);
  return guarded;
};

const [dbGetter, dbSetter] = lazyRef(createDbClient);

/** A libsql transaction that runs only statements the `sql` tag built. */
export type StatementTransaction = Omit<
  Transaction,
  "batch" | "execute" | "executeMultiple"
> &
  TxScope;

/** The libsql client, narrowed to run only statements the `sql` tag built. */
export type StatementClient = Omit<
  Client,
  "batch" | "execute" | "executeMultiple" | "migrate" | "transaction"
> & {
  batch: (
    statements: SqlStatement[],
    mode?: TransactionMode,
  ) => Promise<ResultSet[]>;
  transaction: (mode?: TransactionMode) => Promise<StatementTransaction>;
} & Pick<TxScope, "execute">;

/**
 * Get or create database client
 */
export const getDb = (): StatementClient => withRoundTripGuard(dbGetter());

/** Run schema statements as one script in one round trip. A script keeps each
 * compound trigger body whole. Schema text takes no bound arguments. */
export const executeScript = async (
  statements: readonly SqlStatement[],
): Promise<void> => {
  const bound = statements.find((statement) => statement.args.length > 0);
  if (bound) {
    throw new Error(`A script statement cannot bind values: ${bound.sql}`);
  }
  const script = `${statements.map((statement) => statement.sql).join(";\n")};`;
  await withRoundTripGuard(dbGetter()).executeMultiple(script);
};

/**
 * Set database client (for testing)
 */
export const setDb = (client: Client | StatementClient | null): void =>
  // A StatementClient is a libsql client behind a narrower type.
  dbSetter(client as Client | null);

/** Cast libsql ResultSet rows to a typed array (single centralized assertion) */
export const resultRows = <T>(result: ResultSet): T[] => result.rows as T[];

/** Raised when a write can't get through because the database stays locked after
 *  the retries below — too busy. The request layer turns this into a friendly
 *  auto-reloading page rather than a generic error. */
export class DatabaseBusyError extends namedError("DatabaseBusyError") {
  constructor() {
    super("the database is too busy to complete this write");
  }
}

/** Backoff before each retry of a transient remote-database failure — a
 *  contended write lock on any statement, or a fleeting upstream gateway error
 *  on a read. The ladder stays short: an edge request must answer fast when
 *  the database server is genuinely busy. Its length is the number of retries,
 *  so four attempts in total. */
const TRANSIENT_ERROR_BACKOFF_MS = [50, 150, 350] as const;

/** Backoff for a file database (tests and local dev), longer because the lock
 *  holder is another connection in this same process: under a CPU-starved
 *  parallel run it can hold for about a second, past the whole remote ladder, and
 *  giving up there turns a slow scheduler pass into a busy answer nothing
 *  retries. The total stays inside Cucumber's five-second step budget. */
const FILE_TRANSIENT_ERROR_BACKOFF_MS = [
  ...TRANSIENT_ERROR_BACKOFF_MS,
  700,
  1400,
] as const;

/** The retry ladder for the database this process actually talks to. */
const transientErrorBackoffMs = (): readonly number[] =>
  getEnv("DB_URL")?.startsWith("file:")
    ? FILE_TRANSIENT_ERROR_BACKOFF_MS
    : TRANSIENT_ERROR_BACKOFF_MS;

/** Most physical database attempts made for one retryable operation on the
 *  remote database — the number the edge subrequest budgets are sized from. A
 *  file database retries longer, where no subrequest budget binds. */
export const DATABASE_MAX_ATTEMPTS = TRANSIENT_ERROR_BACKOFF_MS.length + 1;

/**
 * The one place the retry rules run. {@link DATABASE_RETRY} says how often
 * each kind retries on a read and on a write:
 *
 * - SQLITE_BUSY always retries — the lock was never taken, so nothing ran.
 *   When its retries run out, the failure surfaces as DatabaseBusyError.
 * - A fleeting upstream 421/502/503/504 retries on READS ONLY: on a write
 *   it can arrive after the write landed, so a replay can double-apply.
 * - A transport failure retries on reads like an upstream status. On a
 *   write only a Connect failure retries, one attempt — nothing left the
 *   edge. A SendRequest failure can arrive after the statement ran.
 */
const retryOnTransientDatabaseError = <T>(
  run: () => Promise<T>,
  { isRead }: { isRead: boolean },
): Promise<T> =>
  retryWithBackoff(run, transientErrorBackoffMs(), (error, { attempt }) => {
    const kind = classifyDatabaseError(error);
    const rule = DATABASE_RETRY[kind][isRead ? "read" : "write"];
    // A "ladder" rule walks the database's whole transient backoff ladder,
    // whose length is its retry count.
    const retries = rule === "ladder" ? transientErrorBackoffMs().length : rule;
    if (attempt < retries) return;
    if (kind === "locked") throw new DatabaseBusyError();
    throw error;
  });

/** A single-statement runner: takes one statement and resolves to `T`. */
type StatementRunner<T> = (statement: SqlStatement) => Promise<T>;

const executeTrackedStatement: StatementRunner<ResultSet> = (statement) =>
  trackSql(statement.sql, () => getDb().execute(statement));

/**
 * Run a single statement: track it for the query log / N+1 guard, then fire any
 * table-scoped cache invalidation. Every single-statement read and write goes
 * through here (queryOne/queryAll wrap it), so cache invalidation is driven by
 * the write itself rather than by each call site remembering to invalidate.
 */
export const execute: StatementRunner<ResultSet> = async (statement) => {
  const result = await executeTrackedStatement(statement);
  invalidateForSql(statement.sql);
  return result;
};

/** A single statement with no table-scoped invalidation, for a caller keeping its
 *  own cache state through a write. Query tracking still happens. Every other
 *  write wants {@link execute}. */
export const executeWithoutCacheInvalidation: StatementRunner<ResultSet> =
  executeTrackedStatement;

/** The first row of a result set, or null when it returned none. */
const firstRowOrNull = <T>(result: ResultSet): T | null => {
  const rows = resultRows<T>(result);
  return rows.length === 0 ? null : rows[0]!;
};

/**
 * {@link queryAll} for a caller that must read its own writes. The same rows,
 * pinned to the primary, because a replica can lag behind the write and miss
 * them. See {@link queryBatchPrimary}.
 */
export const queryAllPrimary = async <T>(
  statement: SqlStatement,
): Promise<T[]> => {
  const [result] = await queryBatchPrimary([statement]);
  return resultRows<T>(result!);
};

/** Query all rows as a typed array. A read whose cache refill requires
 *  read-your-writes goes to the primary instead. */
export const queryAll = async <T>(statement: SqlStatement): Promise<T[]> =>
  mustReadFromPrimary() && primaryReadMode() !== "read"
    ? queryAllPrimary<T>(statement)
    : resultRows<T>(await execute(statement));

/** The first row that `readAll` returns for a statement, or null when the
 * query returns none. */
const firstRowOn =
  (readAll: typeof queryAll) =>
  async <T>(statement: SqlStatement): Promise<T | null> =>
    (await readAll<T>(statement))[0] ?? null;

/** Query one row, or null when the query returns none. */
export const queryOne = firstRowOn(queryAll);

const requireQueryRow = async <T>(
  row: Promise<T | null>,
  sql: string,
  label: string,
): Promise<T> => {
  const found = await row;
  if (found === null) {
    throw new Error(`${label} query returned no rows: ${sql}`);
  }
  return found;
};

/** Query one required row and name the failed query when none exists. */
export const requireOne = <T>(statement: SqlStatement): Promise<T> =>
  requireQueryRow(queryOne<T>(statement), statement.sql, "Required");

/** Query an optional row on the primary — the singular of
 *  {@link queryAllPrimary}, as {@link queryOne} is of {@link queryAll}. */
export const queryOnePrimary = firstRowOn(queryAllPrimary);

/** Query one required row from the primary. */
export const requireOnePrimary = <T>(statement: SqlStatement): Promise<T> =>
  requireQueryRow(
    queryOnePrimary<T>(statement),
    statement.sql,
    "Required primary",
  );

/** A guard that aborts its batch unless a condition holds. It inserts `row`,
 * which holds a NULL that `target` refuses, when the condition fails. */
export const abortUnless =
  (target: SqlStatement, row: SqlStatement) =>
  (condition: SqlStatement): SqlStatement =>
    sql`INSERT INTO ${target} SELECT ${row} WHERE NOT (${condition})`;

/** Run a guarded write and report whether it changed a row. Zero rows means
 * that the guard refused the write: a replay, a race, or a row in another
 * state. */
export const executeChangedRow = async (
  statement: SqlStatement,
): Promise<boolean> => (await execute(statement)).rowsAffected > 0;

/** True when the query returns a row. The statement should be an existence probe such as
 *  `SELECT 1 ... LIMIT 1`; which columns it selects is ignored. */
export const rowExists = async (statement: SqlStatement): Promise<boolean> =>
  (await queryOne<unknown>(statement)) !== null;

/** Run a query whose single selected column is aliased `id` and return the ids. */
export const queryIdColumn = async (
  statement: SqlStatement,
): Promise<number[]> => {
  const rows = await queryAll<{ id: number }>(statement);
  return rows.map((r) => r.id);
};

/** Count all rows in a table. */
export const countRows = async (table: string): Promise<number> => {
  // COUNT(*) always returns exactly one row, so the result is never null.
  const row = await requireOne<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM ${sqlName(table)}`,
  );
  return row.n;
};

/** One delete-rows-matching-a-field target: which table, matched on which
 * field, for which value. */
export type DeleteByFieldTarget = {
  table: string;
  field: string;
  value: InValue;
};

/** Build the DELETE statement for one {@link DeleteByFieldTarget} — for batches
 * that mix these deletes with other statements. */
export const deleteByFieldStatement = ({
  table,
  field,
  value,
}: DeleteByFieldTarget): SqlStatement =>
  sql`DELETE FROM ${sqlName(table)} WHERE ${sqlName(field)} = ${value}`;

/** Delete rows matching a field value */
export const deleteByField = async (
  table: string,
  field: string,
  value: InValue,
): Promise<void> => {
  await execute(deleteByFieldStatement({ field, table, value }));
};

/** Delete rows from multiple tables in a single batch transaction */
export const deleteByFieldBatch = (
  deletes: DeleteByFieldTarget[],
): Promise<void> => executeBatch(deletes.map(deleteByFieldStatement));

/**
 * Delete one row and the rows that point at it, children first, in one batch.
 * Each child names the column that holds the parent's id.
 */
export const deleteWithChildren =
  (
    table: string,
    children: readonly { field: string; table: string }[],
  ): ((id: number) => Promise<void>) =>
  (id) =>
    deleteByFieldBatch([
      ...children.map((child) => ({ ...child, value: id })),
      { field: "id", table, value: id },
    ]);

/**
 * Reset selected aggregate columns. Each column's recount is an expression
 * that reads the id of the row it sits on, as `<table>.id`.
 */
export const resetAggregates = async <T extends string>(
  table: string,
  entityId: InValue,
  fields: readonly T[],
  recount: Record<T, SqlStatement>,
): Promise<void> => {
  if (fields.length === 0) return;
  const resets = sqlCommas(
    fields.map((field) => sql`${sqlName(field)} = ${recount[field]}`),
  );
  await execute(
    sql`UPDATE ${sqlName(table)} SET ${resets} WHERE id = ${entityId}`,
  );
};

/**
 * Execute a batch with optional query logging, then invalidate caches for every
 * table the batch mutated. Invalidation runs once the transaction has
 * committed; if the batch throws (rollback) it is skipped, so a cache is never
 * cleared for a write that did not land.
 */
const runBatch = async (
  statements: SqlStatement[],
  mode: TransactionMode,
  invalidate: boolean,
  isRead: boolean,
): Promise<ResultSet[]> => {
  const sqls = statements.map(({ sql }) => sql);
  const results = await trackSql(sqls, () =>
    retryOnTransientDatabaseError(() => getDb().batch(statements, mode), {
      isRead,
    }),
  );
  for (const stmt of statements) {
    if (invalidate) invalidateForSql(stmt.sql);
  }
  return results;
};

/**
 * Write without firing cache invalidation. Reserved for plaintext
 * bookkeeping rows (script-version markers) no cache ever holds — written
 * concurrently with requests, the normal path would wipe the settings
 * snapshot the request just loaded.
 */
export const executeBatchWithoutCacheInvalidation = async (
  statements: SqlStatement[],
): Promise<void> => {
  await runBatch(statements, "write", false, false);
};

/** Runs several statements as one batch and answers each in turn: the shape
 *  {@link queryBatch} and {@link executeBatchWithResults} have, and the one
 *  {@link TxScope}'s `batch` fits. A caller that reads either from the client
 *  or through an open transaction takes one of these instead of naming both. */
export type BatchExecutor = (
  statements: SqlStatement[],
) => Promise<ResultSet[]>;

/** What makes a read batch safe to retry: a write smuggled into one is rejected
 *  loudly here, so every statement really is a side-effect-free SELECT. */
const requireReadStatements = (statements: readonly SqlStatement[]): void => {
  for (const statement of statements) {
    if (!isReadSql(statement.sql)) {
      throw new Error(
        `Read-only batch executors accept only SELECT statements: ${statement.sql}`,
      );
    }
  }
};

/** Create a batch executor for a fixed or per-call transaction mode.
 *  `isRead` belongs to the executor rather than being re-derived per
 *  statement: the read executors retry every kind a read may replay, the
 *  write ones only the kinds that provably never ran — see
 *  {@link retryOnTransientDatabaseError} for why. */
const batchFor =
  (
    mode: TransactionMode | (() => TransactionMode),
    isRead: boolean,
  ): BatchExecutor =>
  async (statements) => {
    // The async body turns a smuggled write into a rejected promise, not a
    // synchronous throw.
    if (isRead) requireReadStatements(statements);
    return runBatch(
      statements,
      typeof mode === "function" ? mode() : mode,
      true,
      isRead,
    );
  };

/** Local SQLite has no replica and write mode would only take a needless lock. */
const primaryReadMode = (): TransactionMode => {
  const url = getEnv("DB_URL");
  return url === ":memory:" || url?.startsWith("file:") ? "read" : "write";
};

/** Execute multiple read queries in a single round-trip using Turso batch API. */
export const queryBatch = batchFor(
  () => (mustReadFromPrimary() ? primaryReadMode() : "read"),
  true,
);

/** HTTP primary reads use a separate BEGIN and COMMIT in one pipeline. A complete
 * SELECT-only batch can run on a replica despite its write mode. */
export const queryBatchPrimary = batchFor("write", true);

/** Write statements in order in one transaction, returning every ResultSet —
 *  suited to cascading deletes and multi-step writes. */
export const executeBatchWithResults = batchFor("write", false);

/** Execute multiple write statements, discarding results. */
export const executeBatch = async (
  statements: SqlStatement[],
): Promise<void> => {
  await executeBatchWithResults(statements);
};

/** The slice of an open write transaction handed to a {@link withTransaction}
 *  callback: run statements singly or as one batch; commit/rollback are managed
 *  for you. */
export type TxScope = {
  batch: (statements: SqlStatement[]) => Promise<ResultSet[]>;
  execute: (statement: SqlStatement) => Promise<ResultSet>;
};

/** Reads narrow pre-update state through an open write transaction. */
export type TransactionStateReader<State> = (
  tx: TxScope,
  id: number,
) => Promise<State | null>;

/** The callback {@link withTransaction} runs inside the write transaction: it
 *  issues statements through its {@link TxScope} and resolves to a result. */
type TransactionWork<T> = (tx: TxScope) => Promise<T>;

/** A runner that takes a unit of transactional work and opens what the kind
 *  needs for it — a write transaction ({@link withTransaction}) or a read
 *  snapshot ({@link withReadSnapshot}). */
type TransactionRunner = <T>(work: TransactionWork<T>) => Promise<T>;

const runWriteTransactionOnce = async <T>(
  work: TransactionWork<T>,
  invalidateCaches: boolean,
): Promise<T> => {
  const tx = await getDb().transaction("write");
  const writtenSql: string[] = [];
  let statementCount = 0;
  const scope: TxScope = {
    batch: (statements) => {
      const sqls = statements.map((statement) => statement.sql);
      writtenSql.push(...sqls);
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, sqls.join("; "));
      return trackedTxBatch(tx)(statements);
    },
    execute: (statement) => {
      writtenSql.push(statement.sql);
      // Holding the write lock across many sequential round-trips is the
      // "Transaction timed-out" shape; chatty writes belong in a batch.
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, statement.sql);
      return trackedTxExecute(tx)(statement);
    },
  };
  try {
    const result = await work(scope);
    await tx.commit();
    if (invalidateCaches) {
      for (const sql of writtenSql) invalidateForSql(sql);
    }
    return result;
  } catch (error) {
    // After a failed commit the transaction may already be aborted, so the
    // rollback can itself throw; ignore that and surface the original error.
    await tx.rollback().catch(() => undefined);
    throw error;
  }
};

/** Interactive write transactions share the one libsql connection, so two that
 *  overlap can lose the write lock or leave a statement in progress at the
 *  other's commit ("cannot commit transaction - SQL statements in progress").
 *  Chaining them through this promise runs each begin-to-commit before the next
 *  begins. */
const writeQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

/** A write transaction never starts without room to close itself on failure. */
const TRANSACTION_ROLLBACK_SUBREQUEST_RESERVE = {
  database: 1,
  external: 0,
  total: 1,
};

/**
 * Use this rather than a plain batch only when a multi-step write needs logic
 * between steps, such as create → check capacity → finalize, where a zero-row
 * guard must abort and undo everything.
 *
 * Concurrent calls serialise on the shared connection. A retry re-runs `work`
 * on a fresh transaction, so `work` must be safe to run twice.
 *
 * Cache invalidations fire once the commit succeeds. Settings writers that
 * synchronize their own cache can explicitly preserve the loaded snapshot.
 */
export const withTransaction = <T>(
  work: TransactionWork<T>,
  { invalidateCaches = true }: { invalidateCaches?: boolean } = {},
): Promise<T> => {
  // The async body runs synchronously up to its first await — reading the prior
  // tail there — so reserving our slot (`writeQueue.tail = run`) before any other
  // call interleaves keeps the queue strictly ordered. We wait for the previous
  // transaction however it settled (`.catch` swallows its failure — that is its
  // own caller's concern), then run, retrying a contended lock on a fresh tx.
  const run = (async (): Promise<T> => {
    await writeQueue.tail.catch(() => undefined);
    return retryOnTransientDatabaseError(
      () =>
        withSubrequestReserve(TRANSACTION_ROLLBACK_SUBREQUEST_RESERVE, () =>
          runWriteTransactionOnce(work, invalidateCaches),
        ),
      {
        // A transaction holds writes: an upstream failure at begin or commit
        // may arrive after they landed, so a retried transaction would replay
        // them. Only the kinds that provably never ran anything retry — lock
        // contention, and a Connect failure that never left the edge.
        isRead: false,
      },
    );
  })();
  writeQueue.tail = run;
  return run;
};

/** Run work on the caller's open transaction, or open one when there is no
 * caller transaction. Transaction-aware table methods use this so direct calls
 * and larger atomic operations share the same write path. */
export const useTransaction = <T>(
  transaction: TxScope | undefined,
  work: TransactionWork<T>,
): Promise<T> =>
  transaction === undefined ? withTransaction(work) : work(transaction);

/**
 * Run read-only work against one database snapshot.
 *
 * The transaction begins `READ ONLY`, so it never takes the write lock and
 * never blocks a writer; every statement it sees is one snapshot of the data,
 * however many round trips the work makes. Statements must be SELECTs — a
 * write smuggled into the scope throws before it reaches the database. The
 * snapshot never commits: it ends by closing; cache invalidation does not
 * apply because nothing was written. A transient failure replays the whole
 * attempt on a fresh transaction, so `work` must be safe to run twice, as
 * with {@link withTransaction}.
 */
export const withReadSnapshot: TransactionRunner = (work) =>
  retryOnTransientDatabaseError(
    async () => {
      // READ ONLY never takes the write lock, and a replica-pinned transaction
      // is one consistent database state.
      const tx = await getDb().transaction("read");
      // The SELECT-only runners the snapshot hands its work: each refuses a
      // non-SELECT before it reaches `tx`.
      const batch = (statements: SqlStatement[]): Promise<ResultSet[]> => {
        requireReadStatements(statements);
        return trackedTxBatch(tx)(statements);
      };
      const execute = (statement: SqlStatement): Promise<ResultSet> => {
        requireReadStatements([statement]);
        return trackedTxExecute(tx)(statement);
      };
      try {
        return await work({ batch, execute });
      } finally {
        tx.close();
      }
    },
    // Every statement inside is a read, so a retried attempt cannot double-apply.
    { isRead: true },
  );

/**
 * Run a write that ends in `RETURNING` and read back the row it wrote. A
 * write that returns no row means nothing was written — fail there, loudly.
 */
export const executeReturningRow = async <T>(
  statement: SqlStatement,
): Promise<T> => {
  const row = firstRowOrNull<T>(await execute(statement));
  if (row === null) {
    throw new Error(`Write returned no row: ${statement.sql}`);
  }
  return row;
};

/**
 * The key of the row an `INSERT … RETURNING` wrote, read from the row itself
 * rather than from the driver's optional `lastInsertRowid`. Every generated key
 * is a positive integer, so anything else means nothing downstream can be keyed
 * on this row and the write must fail here.
 */
export const insertedRowId = (
  result: ResultSet,
  primaryKey: string = "id",
): number => {
  const id = resultRows<Record<string, unknown>>(result)[0]?.[primaryKey];
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  throw new Error(
    `INSERT did not return the ${primaryKey} of the row it wrote (got ${JSON.stringify(
      id,
    )})`,
  );
};

/**
 * Write one row `statement` in a fresh write transaction and run `persist` (the
 * coupled join-table writes) on the same `tx`, so the row and its side writes
 * commit or roll back together. On update, the optional `readState` step runs
 * before the statement — it reads the state that reaches `persist` and may
 * refuse the write by throwing; creates skip it. Returns the row id.
 */
export const writeRowInTransaction = <State = never>(
  statement: SqlStatement,
  existingId: number | null,
  persist: (tx: TxScope, id: number, state: State | null) => Promise<void>,
  readState?: TransactionStateReader<State>,
): Promise<number> =>
  withTransaction(async (tx) => {
    const state =
      existingId !== null && readState ? await readState(tx, existingId) : null;
    const res = await tx.execute(statement);
    const id = existingId ?? insertedRowId(res);
    await persist(tx, id, state);
    return id;
  });

/** Build an INSERT that starts with `opening`, from a column-to-value record. */
const insertStartingWith =
  (opening: SqlStatement) =>
  (
    table: string,
    values: Record<string, SqlSlot>,
    returningColumn?: string,
  ): SqlStatement => {
    const columns = sqlNames(Object.keys(values));
    const slots = sqlCommas(
      Object.values(values).map((value) => sql`${value}`),
    );
    const written = sql`${opening} ${sqlName(table)} (${columns}) VALUES (${slots})`;
    return returningColumn === undefined
      ? written
      : sql`${written} RETURNING ${sqlName(returningColumn)}`;
  };

/**
 * Build an INSERT statement from a table name and column-to-value record. A
 * value that is itself a statement goes into the SQL as written, which is how
 * a column takes an expression such as `last_insert_rowid()`.
 *
 * Pass `returningColumn` when the caller needs a value back from the written
 * row, such as a generated key read with {@link insertedRowId}.
 */
export const insert = insertStartingWith(sql`INSERT INTO`);

/**
 * {@link insert}, dropping a row whose unique key is already stored instead of
 * raising a constraint error. This is the once-only latch resumable flows lean
 * on: a replayed write re-derives the same key and lands nowhere. It silences
 * every conflict on the statement, so use it only where the unique key IS the
 * idempotency rule.
 */
export const insertOrIgnore = insertStartingWith(sql`INSERT OR IGNORE INTO`);

/** One `column = value` per entry: the shared clause shape of {@link update}'s
 * SET and WHERE parts. */
export const equalityClauses = (
  values: Record<string, SqlSlot>,
): SqlStatement[] =>
  Object.entries(values).map(
    ([column, value]) => sql`${sqlName(column)} = ${value}`,
  );

/**
 * Build an UPDATE statement, the WHERE record ANDed as equality checks. A SET
 * value can be a statement, such as a counter increment. A write needing a
 * richer guard — `IS NULL`, an inequality, a subquery — keeps its own SQL
 * rather than bending this one.
 */
export const update = (
  table: string,
  set: Record<string, SqlSlot>,
  where: Record<string, InValue>,
): SqlStatement =>
  sql`UPDATE ${sqlName(table)} SET ${sqlCommas(
    equalityClauses(set),
  )} WHERE ${sqlJoin(equalityClauses(where), sql` AND `)}`;

/** Build the {@link update} statement and run it in one call — the executing
 * form for the single-statement call sites (batch and transactional callers
 * use {@link update} itself). */
export const executeUpdate = (
  ...parts: Parameters<typeof update>
): Promise<ResultSet> => execute(update(...parts));
