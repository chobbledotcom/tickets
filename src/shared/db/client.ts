/**
 * Database client setup and core utilities.
 *
 * The low-level runners here record every statement for the query log, so a
 * helper built on them is timed and counted without asking.
 */

import {
  type Client,
  createClient,
  type InStatement,
  type InValue,
  LibsqlError,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { beginTransaction, wrapExecute } from "#db/libsql-call.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import {
  countDatabaseRoundTrip,
  enforceTransactionRoundTripGuard,
  trackSql,
} from "#db/query-log.ts";
import { lazyRef } from "#fp";
import { invalidateCachesForWrite } from "#shared/cache-registry.ts";
import { getEnv } from "#shared/env.ts";
import { namedError } from "#shared/named-error.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import { withSubrequestReserve } from "#shared/subrequest-budget.ts";

/**
 * Match the target table of a mutating statement (INSERT/UPDATE/DELETE/REPLACE),
 * the mirror of query-log's read detector. Anchored at the start so it fails
 * fast on the SELECTs that dominate the call volume. The optional
 * `OR <action>` / `OR <action> INTO` clauses cover libsql's conflict variants.
 */
const WRITE_TABLE_RE =
  /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`]?(\w+)/i;

/** A CTE-led statement's tail, without its leading `WITH ... AS (...)`. Every
 *  CTE closes with `) <verb> ...`, so the alternation catches the tail whichever
 *  verb follows. See {@link writeSqlOf} for what depends on this. */
const CTE_PREFIX_RE =
  /^\s*WITH\b[\s\S]*?\)\s*((?:INSERT|UPDATE|DELETE|REPLACE|SELECT)[\s\S]*)$/i;

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
  let depth = 0;
  let start = 0;
  for (const [i, ch] of setClause.split("").entries()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      addAssignment(setClause.slice(start, i).trim());
      start = i + 1;
    }
  }
  addAssignment(setClause.slice(start).trim());
  return columns.size > 0 ? columns : null;
};

/**
 * The real statement inside a possibly CTE-led string, so the write regexes
 * anchor on the true verb: a `WITH ... INSERT` is a write, not a bare SELECT
 * that the write gates would skip. {@link isReadSql} and {@link invalidateForSql}
 * share it, so retry and cache invalidation cannot disagree on what is a write.
 */
const writeSqlOf = (sql: string): string => CTE_PREFIX_RE.exec(sql)?.[1] ?? sql;

/** The SQL text of a libsql statement, which may be a bare string or a
 *  `{ sql, args }` object. Shared by the batch/transaction scopes and the
 *  batch retry gate so the InStatement shape is unwrapped in one place. */
const sqlOf = (stmt: InStatement): string =>
  typeof stmt === "string" ? stmt : stmt.sql;

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
  // (a branch here would leave one side uncovered).
  return createClient({
    authToken: getEnv("DB_TOKEN"),
    url,
  } as Parameters<typeof createClient>[0]);
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

const executeWithRoundTripGuard = executeWithRoundTrip((_statement, execute) =>
  execute(),
);

/** Count and retry a bare client statement. Transaction statements use only the
 * round-trip guard above because their surrounding write must not be replayed. */
const executeWithTransientRetry = executeWithRoundTrip((statement, execute) =>
  retryOnTransientDatabaseError(execute, {
    retryUpstream: isReadSql(sqlOf(statement)),
  }),
);

const transactionWithRoundTripGuard = (transaction: Transaction): Transaction =>
  proxyMembers(transaction, {
    batch: (statements: InStatement[]) =>
      databaseRoundTrip("transaction batch", () =>
        transaction.batch(statements),
      ),
    commit: (): Promise<void> =>
      databaseRoundTrip("transaction commit", () => transaction.commit()),
    execute: executeWithRoundTripGuard(transaction, "transaction statement"),
    executeMultiple: (sql: string): Promise<void> =>
      databaseRoundTrip("transaction script", () =>
        transaction.executeMultiple(sql),
      ),
    // Rollback is mandatory cleanup: an interactive transaction left open (its
    // rollback blocked) poisons the shared write connection for the rest of the
    // request. It is counted like any other subrequest — so the running total
    // stays accurate for later calls — but never blocked, so it always runs even
    // once the budget is spent (within the migration reserve, or on any path
    // that still has real headroom below Bunny's hard cap).
    rollback: (): Promise<void> =>
      databaseRoundTrip(
        "transaction rollback",
        () => transaction.rollback(),
        false,
      ),
  });

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

/**
 * Get or create database client
 */
export const getDb = (): Client => withRoundTripGuard(dbGetter());

/**
 * Set database client (for testing)
 */
export const setDb = (client: Client | null): void => dbSetter(client);

/** Cast libsql ResultSet rows to a typed array (single centralized assertion) */
export const resultRows = <T>(result: ResultSet): T[] =>
  result.rows as unknown as T[];

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

/** SQLite has a single writer, so a contended write surfaces as SQLITE_BUSY —
 *  thrown immediately by the local driver as "database is locked" when a bare
 *  statement can't take the lock, or at an interactive transaction's commit as
 *  "cannot commit transaction - SQL statements in progress" when another writer
 *  still holds the connection. Both carry SQLITE_BUSY in the message. */
const isDatabaseLocked = (error: unknown): boolean =>
  error instanceof Error &&
  /SQLITE_BUSY|database is locked/i.test(error.message);

/** The libsql server briefly rejecting a fresh connection (421) or its gateway
 *  timing out / becoming momentarily unreachable (502/503/504), which the
 *  client surfaces as a SERVER_ERROR LibsqlError naming the HTTP status. Worth
 *  a retry on a read; a genuine client or server fault (400/500) would only be
 *  replayed by one. */
const TRANSIENT_UPSTREAM_STATUS_RE =
  /Server returned HTTP status (?:421|502|503|504)\b/;

const isTransientUpstreamError = (error: unknown): boolean =>
  error instanceof LibsqlError &&
  error.code === "SERVER_ERROR" &&
  TRANSIENT_UPSTREAM_STATUS_RE.test(error.message);

/** The one statement shape the upstream retry may replay: a SELECT, possibly
 *  CTE-led. Anything else — a write, DDL (CREATE/ALTER/DROP), a PRAGMA — may
 *  have side effects that landed before the gateway timed out, so the gate
 *  fails closed: only a positively recognized read retries. */
const READ_SQL_RE = /^\s*select\b/i;

/** Whether a statement is a read the upstream retry may replay, the CTE prefix
 *  stripped first so a `WITH ... SELECT` still reads as a SELECT. */
const isReadSql = (sql: string): boolean => READ_SQL_RE.test(writeSqlOf(sql));

/**
 * Retry `run` through a transient failure, backing off between attempts. This is
 * the one place these two rules are spelled out:
 *   - a contended write lock (SQLITE_BUSY) always retries, the lock never having
 *     been taken, so nothing ran. One that outlasts the retries becomes
 *     {@link DatabaseBusyError}, the request layer's friendly busy page.
 *   - a fleeting upstream 421/502/503/504 retries on reads only. On a write the
 *     same response may arrive after the write landed, so a replay would
 *     double-apply — writes, and the transactions holding them, never retry
 *     upstream. One that outlasts the retries rethrows itself, so a real outage
 *     reaches the log as what it is.
 *
 * Every other error propagates at once.
 */
const retryOnTransientDatabaseError = <T>(
  run: () => Promise<T>,
  { retryUpstream }: { retryUpstream: boolean },
): Promise<T> =>
  retryWithBackoff(run, transientErrorBackoffMs(), (error, { willRetry }) => {
    if (retryUpstream && isTransientUpstreamError(error)) return;
    if (!isDatabaseLocked(error)) throw error;
    if (!willRetry) throw new DatabaseBusyError();
  });

/** A single-statement runner: takes the SQL and its optional bound args and
 * resolves to `T`. Shared by the tracked-execute and public execute helpers. */
type StatementRunner<T> = (sql: string, args?: InValue[]) => Promise<T>;

const executeTrackedStatement: StatementRunner<ResultSet> = (sql, args) =>
  trackSql(sql, () =>
    args ? getDb().execute({ args, sql }) : getDb().execute(sql),
  );

/** A SQL statement and its optional bound args — the shared parameters of the
 * single-statement query and write helpers below. */
type SqlArgs = [sql: string, args?: InValue[]];
type SqlWithArgs = [sql: string, args: InValue[]];

/**
 * Run a single statement: track it for the query log / N+1 guard, then fire any
 * table-scoped cache invalidation. Every single-statement read and write goes
 * through here (queryOne/queryAll wrap it), so cache invalidation is driven by
 * the write itself rather than by each call site remembering to invalidate.
 */
export const execute: StatementRunner<ResultSet> = async (sql, args) => {
  const result = await executeTrackedStatement(sql, args);
  invalidateForSql(sql);
  return result;
};

/** A single statement with no table-scoped invalidation, for a caller keeping its
 *  own cache state through a write. Query tracking still happens. Every other
 *  write wants {@link execute}. */
export const executeWithoutCacheInvalidation = (
  ...[sql, args]: SqlArgs
): Promise<ResultSet> => executeTrackedStatement(sql, args);

/** The first row of a result set, or null when it returned none. */
const firstRowOrNull = <T>(result: ResultSet): T | null => {
  const rows = resultRows<T>(result);
  return rows.length === 0 ? null : rows[0]!;
};

/**
 * Query all rows of one statement on the primary, for a caller that must read
 * its own writes — a plain {@link queryAll} can be served by a lagging replica
 * and miss them. See {@link queryBatchPrimary}. `args` is required: a read-back
 * always keys on the rows the write just put there.
 */
export const queryAllPrimary = async <T>(
  sql: string,
  args: InValue[],
): Promise<T[]> => {
  const [result] = await queryBatchPrimary([{ args, sql }]);
  return resultRows<T>(result!);
};

/** Query all rows, returning a typed array. A read whose cache refill requires
 *  read-your-writes goes to the primary instead. */
export const queryAll = async <T>(...[sql, args]: SqlArgs): Promise<T[]> =>
  mustReadFromPrimary() && primaryReadMode() !== "read"
    ? queryAllPrimary<T>(sql, args ?? [])
    : resultRows<T>(await execute(sql, args));

/** Query one row, or null when the query returns none. */
export const queryOne = async <T>(...[sql, args]: SqlArgs): Promise<T | null> =>
  (await queryAll<T>(sql, args))[0] ?? null;

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
export const requireOne = <T>(...[sql, args]: SqlArgs): Promise<T> =>
  requireQueryRow(queryOne<T>(sql, args), sql, "Required");

/** Query an optional row on the primary — the singular of
 *  {@link queryAllPrimary}, as {@link queryOne} is of {@link queryAll}. */
export const queryOnePrimary = async <T>(
  sql: string,
  args: InValue[],
): Promise<T | null> => (await queryAllPrimary<T>(sql, args))[0] ?? null;

/** Query one required row from the primary. */
export const requireOnePrimary = <T>(...[sql, args]: SqlWithArgs): Promise<T> =>
  requireQueryRow(queryOnePrimary<T>(sql, args), sql, "Required primary");

/** True when the query returns a row. `sql` should be an existence probe such as
 *  `SELECT 1 ... LIMIT 1`; which columns it selects is ignored. */
export const rowExists = async (
  sql: string,
  args: InValue[],
): Promise<boolean> => (await queryOne<unknown>(sql, args)) !== null;

/**
 * Build an existence check for "one leading id, matched against a list of ids".
 * The checker binds `leadingId` to the first `?` and expands `ids` into the
 * `IN (...)` that `buildSql` embeds through the placeholder string it is handed.
 * Empty `ids` runs an empty `IN ()`, which matches nothing.
 */
export const rowExistsForIdList =
  (buildSql: (idsPlaceholders: string) => string) =>
  (leadingId: number, ids: number[]): Promise<boolean> =>
    rowExists(buildSql(inPlaceholders(ids)), [leadingId, ...ids]);

/** Run a query whose single selected column is aliased `id` and return the ids. */
export const queryIdColumn = async (
  sql: string,
  args?: InValue[],
): Promise<number[]> => {
  const rows = await queryAll<{ id: number }>(sql, args);
  return rows.map((r) => r.id);
};

/** Count all rows in a table. `table` must be a trusted constant, not input. */
export const countRows = async (table: string): Promise<number> => {
  // COUNT(*) always returns exactly one row, so the result is never null.
  const row = await requireOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}`,
    [],
  );
  return row!.n;
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
}: DeleteByFieldTarget): { sql: string; args: InValue[] } => ({
  args: [value],
  sql: `DELETE FROM ${table} WHERE ${field} = ?`,
});

/** Delete rows matching a field value */
export const deleteByField = async (
  table: string,
  field: string,
  value: InValue,
): Promise<void> => {
  const { args, sql } = deleteByFieldStatement({ field, table, value });
  await execute(sql, args);
};

/** Delete rows from multiple tables in a single batch transaction */
export const deleteByFieldBatch = (
  deletes: DeleteByFieldTarget[],
): Promise<void> => executeBatch(deletes.map(deleteByFieldStatement));

/**
 * Reset selected aggregate columns from trusted SQL expressions. Each
 * expression must use the entity id as its only placeholder.
 */
export const resetAggregates = async <T extends string>(
  table: string,
  entityId: InValue,
  fields: readonly T[],
  resetSql: Record<T, string>,
): Promise<void> => {
  if (fields.length === 0) return;
  const sql = `UPDATE ${table} SET ${fields
    .map((field) => resetSql[field])
    .join(", ")} WHERE id = ?`;
  await execute(sql, fields.map(() => entityId).concat(entityId));
};

/**
 * A single SQL statement plus its bound arguments — the object form libsql's
 * batch API accepts. This is the one shared shape for a `{ sql, args }` pair;
 * callers that build statements to hand to {@link executeBatch} and friends
 * import this rather than re-declaring the same object type locally.
 */
export type SqlStatement = { sql: string; args: InValue[] };

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
  retryUpstream: boolean,
): Promise<ResultSet[]> => {
  const sqls = statements.map(({ sql }) => sql);
  const results = await trackSql(sqls, () =>
    retryOnTransientDatabaseError(() => getDb().batch(statements, mode), {
      retryUpstream,
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
const requireReadStatements = (statements: SqlStatement[]): void => {
  for (const { sql } of statements) {
    if (!isReadSql(sql)) {
      throw new Error(
        `Read-only batch executors accept only SELECT statements: ${sql}`,
      );
    }
  }
};

/** Create a batch executor for a fixed or per-call transaction mode.
 *  `retryUpstream` belongs to the executor rather than being re-derived per
 *  statement: the read executors always retry, the write ones never do — see
 *  {@link retryOnTransientDatabaseError} for why. */
const batchFor =
  (
    mode: TransactionMode | (() => TransactionMode),
    retryUpstream: boolean,
  ): BatchExecutor =>
  async (statements) => {
    if (retryUpstream) requireReadStatements(statements);
    return runBatch(
      statements,
      typeof mode === "function" ? mode() : mode,
      true,
      retryUpstream,
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

/**
 * Read queries pinned to the primary in one round-trip, for a caller that must
 * read its own writes — the migrator verifying DDL it just applied. "read" mode
 * can be served by a lagging replica, so this asks for "write" mode, which Turso
 * always serves from the primary. Holding only SELECTs is fine: the mode buys the
 * connection, not permission to write.
 */
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
  batch: (statements: InStatement[]) => Promise<ResultSet[]>;
  execute: (stmt: InStatement) => Promise<ResultSet>;
};

/** Reads narrow pre-update state through an open write transaction. */
export type TransactionStateReader<State> = (
  tx: TxScope,
  id: number,
) => Promise<State | null>;

/** The callback {@link withTransaction} runs inside the write transaction: it
 *  issues statements through its {@link TxScope} and resolves to a result. */
type TransactionWork<T> = (tx: TxScope) => Promise<T>;

/**
 * Run `work` in one freshly-begun interactive write transaction, committing on
 * success and rolling back on any error. Cache invalidations fire once after a
 * successful commit, and none after a rollback. A lock lost while beginning or
 * committing throws SQLITE_BUSY, which {@link withTransaction} retries; an
 * upstream error is never retried here, per
 * {@link retryOnTransientDatabaseError}.
 */
const runWriteTransactionOnce = async <T>(
  work: TransactionWork<T>,
): Promise<T> => {
  const tx = await getDb().transaction("write");
  const writtenSql: string[] = [];
  let statementCount = 0;
  const scope: TxScope = {
    batch: (statements) => {
      const sqls = statements.map(sqlOf);
      writtenSql.push(...sqls);
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, sqls.join("; "));
      return trackSql(sqls, () => tx.batch(statements));
    },
    execute: (stmt) => {
      const sql = sqlOf(stmt);
      writtenSql.push(sql);
      // Holding the write lock across many sequential round-trips is the
      // "Transaction timed-out" shape; chatty writes belong in a batch.
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, sql);
      // Tracked too, so reads inside the callback reach the debug footer and the
      // N+1 guard.
      return trackSql(sql, () => tx.execute(stmt));
    },
  };
  try {
    const result = await work(scope);
    await tx.commit();
    for (const sql of writtenSql) invalidateForSql(sql);
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
 * Run `work` inside one interactive write transaction, committing on success
 * and rolling back (then rethrowing) on any error. Use this rather than a plain
 * batch when a multi-step write needs logic between steps — create → check
 * capacity → finalize, where a zero-row guard must abort and undo everything.
 *
 * Concurrent calls serialise: each waits for the previous transaction to settle,
 * so two never overlap on the shared connection. A contended lock is retried with
 * backoff, each retry re-running `work` on a fresh transaction.
 *
 * Statements run through the provided `execute` are tracked, and their
 * table-scoped cache invalidations fire once the commit succeeds, so callers get
 * the same automatic invalidation as a single-statement `execute`.
 */
export const withTransaction = <T>(work: TransactionWork<T>): Promise<T> => {
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
          runWriteTransactionOnce(work),
        ),
      {
        // A transaction holds writes: an upstream failure at begin or commit
        // may arrive after they landed, so a retried transaction would replay
        // them. Only retry lock contention, which never ran anything.
        retryUpstream: false,
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
 * Run a write that ends in `RETURNING` and read back the row it wrote. A
 * write that returns no row means nothing was written — fail there, loudly.
 */
export const executeReturningRow = async <T>(
  ...[sql, args]: SqlWithArgs
): Promise<T> => {
  const row = firstRowOrNull<T>(await execute(sql, args));
  if (row === null) throw new Error(`Write returned no row: ${sql}`);
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
 * commit or roll back together. On update, an optional `readState` runs before
 * the statement and its result reaches `persist`; creates skip it. Returns the
 * row id — `existingId` on update, or the key the INSERT returned on create.
 */
export const writeRowInTransaction = <State = never>(
  statement: InStatement,
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

/** Build SQL placeholders for an IN clause, e.g. "?, ?, ?" */
export const inPlaceholders = (values: readonly unknown[]): string =>
  values.map(() => "?").join(", ");

/** Sentinel for raw SQL expressions in insert() values */
const RAW_SQL = Symbol("raw-sql");
type RawSql = { [RAW_SQL]: string };

/** Embed a raw SQL expression (e.g. `last_insert_rowid()`) */
export const rawSql = (expr: string): RawSql => ({ [RAW_SQL]: expr }) as RawSql;

/**
 * Rewrite a built INSERT as `INSERT OR IGNORE`, dropping a row whose unique key
 * is already stored instead of raising a constraint error. This is the once-only
 * latch resumable flows lean on: a replayed write re-derives the same key and
 * lands nowhere. It silences every conflict on the statement, so use it only
 * where the unique key IS the idempotency rule.
 */
export const orIgnore = (statement: SqlStatement): SqlStatement => ({
  args: [...statement.args],
  sql: statement.sql.replace(/^INSERT INTO/, "INSERT OR IGNORE INTO"),
});

/**
 * Build an INSERT statement from a table name and column→value record. A
 * {@link rawSql} value goes into the SQL as written rather than becoming a bound
 * placeholder, which is how a column takes an expression:
 *
 * ```ts
 * insert("listing_attendees", { attendee_id: rawSql("last_insert_rowid()") })
 * // → VALUES (last_insert_rowid())   with no arg bound
 * ```
 *
 * Pass `returningColumns` when the caller needs something back from the written
 * row — a generated key, say, read with {@link insertedRowId}.
 */
export const insert = (
  table: string,
  values: Record<string, InValue | RawSql>,
  returningColumns?: string,
): { sql: string; args: InValue[] } => {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const args: InValue[] = [];

  for (const [col, val] of Object.entries(values)) {
    columns.push(col);
    if (val !== null && typeof val === "object" && RAW_SQL in val) {
      placeholders.push(val[RAW_SQL]);
    } else {
      placeholders.push("?");
      args.push(val as InValue);
    }
  }

  const returning = returningColumns ? ` RETURNING ${returningColumns}` : "";
  return {
    args,
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(
      ", ",
    )})${returning}`,
  };
};

/** One `column = <?|raw>` fragment per entry, collecting plain values into
 * `args` — the shared clause shape of {@link update}'s SET and WHERE parts. */
const equalityClauses = (
  values: Record<string, InValue | RawSql>,
  args: InValue[],
): string[] =>
  Object.entries(values).map(([col, val]) => {
    if (val !== null && typeof val === "object" && RAW_SQL in val) {
      return `${col} = ${val[RAW_SQL]}`;
    }
    args.push(val as InValue);
    return `${col} = ?`;
  });

/**
 * Build an UPDATE statement, the WHERE record ANDed as equality checks. SET
 * values may be {@link rawSql} expressions, such as a counter increment. A write
 * needing a richer guard — `IS NULL`, an inequality, a subquery — keeps its own
 * SQL rather than bending this one.
 */
export const update = (
  table: string,
  set: Record<string, InValue | RawSql>,
  where: Record<string, InValue>,
): SqlStatement => {
  const args: InValue[] = [];
  const setClauses = equalityClauses(set, args);
  const whereClauses = equalityClauses(where, args);
  return {
    args,
    sql: `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(
      " AND ",
    )}`,
  };
};

/** Build the {@link update} statement and run it in one call — the executing
 * form for the single-statement call sites (batch and transactional callers
 * use {@link update} itself). */
export const executeUpdate = (
  ...parts: Parameters<typeof update>
): Promise<ResultSet> => {
  const stmt = update(...parts);
  return execute(stmt.sql, stmt.args);
};
