/**
 * Database client setup and core utilities
 *
 * When query logging is enabled (admin debug footer), the core query
 * functions (queryOne, queryAll, queryBatch, deleteByField) time each
 * call and record the SQL via the query-log module.
 */

import {
  type Client,
  createClient,
  type InStatement,
  type InValue,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { lazyRef } from "#fp";
import {
  invalidateCachesForWrite,
  type WriteVerb,
} from "#shared/cache-registry.ts";
import { beginTransaction, wrapExecute } from "#shared/db/libsql-call.ts";
import {
  countDatabaseRoundTrip,
  enforceTransactionRoundTripGuard,
  trackSql,
} from "#shared/db/query-log.ts";
import { getEnv } from "#shared/env.ts";
import { namedError } from "#shared/named-error.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { retryWithBackoff } from "#shared/retry.ts";

/**
 * Match the target table of a mutating statement (INSERT/UPDATE/DELETE/REPLACE),
 * the mirror of query-log's read detector. Anchored at the start so it fails
 * fast on the SELECTs that dominate the call volume. The optional
 * `OR <action>` / `OR <action> INTO` clauses cover libsql's conflict variants.
 */
const WRITE_TABLE_RE =
  /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`]?(\w+)/i;

/** A CTE-led UPDATE's mutating statement, without its leading read expression. */
const CTE_UPDATE_RE = /^\s*WITH\b[\s\S]*?\)\s*(UPDATE[\s\S]*)$/i;

/**
 * Parse the column names assigned by an UPDATE SET clause.
 * Returns a lower-cased Set, or null if the SET clause cannot be found.
 * Each `col = expr` left-hand side is extracted; commas inside parentheses
 * are skipped so subexpressions don't split assignments. If extraction yields
 * no columns the caller falls back to unconditional invalidation.
 * Exported for unit testing; not part of the public db-client API.
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
  for (let i = 0; i < setClause.length; i++) {
    const ch = setClause[i]!;
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
 * After a successful write, invalidate every cache that declared a dependency
 * on the mutated table. A no-op for reads (the regex doesn't match) and for
 * tables no cache depends on. For UPDATEs, the SET-clause columns are
 * extracted so column-gated dependencies (e.g. listings ← listing_attendees
 * only when quantity / price_paid / listing_id are written) can skip the
 * invalidation when only unrelated columns are touched. If column extraction
 * fails the write is treated as unconditional — safe over stale.
 */
const invalidateForSql = (sql: string): void => {
  const writeSql = CTE_UPDATE_RE.exec(sql)?.[1] ?? sql;
  const match = WRITE_TABLE_RE.exec(writeSql);
  if (!match) return;
  const table = match[1]!.toLowerCase();
  const firstWord = writeSql.trimStart().split(/\s/)[0]!.toLowerCase();
  const verb: WriteVerb =
    firstWord === "delete" || firstWord === "update" || firstWord === "replace"
      ? (firstWord as WriteVerb)
      : "insert";
  if (verb === "update") {
    const columns = extractUpdateColumns(writeSql);
    if (columns === null) {
      // Parse failure: fall back to unconditional (treat as INSERT-like)
      invalidateCachesForWrite(table, { columns: new Set(), verb: "insert" });
    } else {
      invalidateCachesForWrite(table, { columns, verb: "update" });
    }
  } else {
    invalidateCachesForWrite(table, { columns: new Set(), verb });
  }
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

const databaseRoundTrip = <T>(operation: string, run: () => T): T => {
  countDatabaseRoundTrip(operation);
  return run();
};

const executeWithRoundTripGuard = (
  target: Pick<Client, "execute">,
  operation: string,
) =>
  wrapExecute(target, (_statement, execute) =>
    databaseRoundTrip(operation, execute),
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
    rollback: (): Promise<void> =>
      databaseRoundTrip("transaction rollback", () => transaction.rollback()),
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
    execute: executeWithRoundTripGuard(client, "statement"),
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

/** Backoff before each retry of a contended database lock; its length is the
 *  number of retries, so four attempts in total. */
const WRITE_LOCK_RETRY_BACKOFF_MS = [50, 150, 350] as const;

/** SQLite has a single writer, so a contended write surfaces as SQLITE_BUSY —
 *  thrown immediately by the local driver as "database is locked" when a bare
 *  statement can't take the lock, or at an interactive transaction's commit as
 *  "cannot commit transaction - SQL statements in progress" when another writer
 *  still holds the connection. Both carry SQLITE_BUSY in the message. */
const isDatabaseLocked = (error: unknown): boolean =>
  error instanceof Error &&
  /SQLITE_BUSY|database is locked/i.test(error.message);

/**
 * Retry `run` while it loses a contended write lock, backing off between attempts
 * so a brief overlap with another writer resolves itself rather than failing the
 * loser. A lock that outlasts the retries surfaces as {@link DatabaseBusyError}
 * (the request layer's friendly busy page); every other error propagates at once.
 */
const retryOnDatabaseLock = <T>(run: () => Promise<T>): Promise<T> =>
  retryWithBackoff(run, WRITE_LOCK_RETRY_BACKOFF_MS, (error, { willRetry }) => {
    if (!isDatabaseLocked(error)) throw error;
    if (!willRetry) throw new DatabaseBusyError();
  });

/** A single-statement runner: takes the SQL and its optional bound args and
 * resolves to `T`. Shared by the tracked-execute and public execute helpers. */
type StatementRunner<T> = (sql: string, args?: InValue[]) => Promise<T>;

const executeTrackedStatement: StatementRunner<ResultSet> = (sql, args) =>
  trackSql(sql, () =>
    retryOnDatabaseLock(() =>
      args ? getDb().execute({ args, sql }) : getDb().execute(sql),
    ),
  );

/** A SQL statement and its optional bound args — the shared parameters of the
 * single-statement query and write helpers below. */
type SqlArgs = [sql: string, args?: InValue[]];

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

/**
 * Run a single statement without table-scoped cache invalidation.
 *
 * This is intentionally narrow: callers that maintain their own cache state
 * during a write can avoid a broad invalidation/reset while still preserving
 * query tracking. Other writes should use `execute`.
 */
export const executeWithoutCacheInvalidation = (
  ...[sql, args]: SqlArgs
): Promise<ResultSet> => executeTrackedStatement(sql, args);

/** The first row of a result set, or null when it returned none. */
const firstRowOrNull = <T>(result: ResultSet): T | null => {
  const rows = resultRows<T>(result);
  return rows.length === 0 ? null : rows[0]!;
};

/** Query single row, returning null if not found */
export const queryOne = async <T>(...[sql, args]: SqlArgs): Promise<T | null> =>
  firstRowOrNull<T>(await execute(sql, args));

/**
 * Query a single row on the primary (read-your-writes), returning null if not
 * found. Use this to read a row back immediately after committing its own write:
 * a plain {@link queryOne} runs in "read" mode, which Turso can route to a
 * replica lagging the just-committed write and so miss the row (returning null);
 * routing through {@link queryBatchPrimary} ("write" mode) always hits the
 * primary. Mirrors the same guard on {@link syncListingPrices}. `args` is
 * required — every read-back keys on the written row's id.
 */
export const queryOnePrimary = async <T>(
  sql: string,
  args: InValue[],
): Promise<T | null> => {
  const [result] = await queryBatchPrimary([{ args, sql }]);
  return firstRowOrNull<T>(result!);
};

/** Query all rows, returning a typed array */
export const queryAll = async <T>(...[sql, args]: SqlArgs): Promise<T[]> =>
  resultRows<T>(await execute(sql, args));

/**
 * True when the query returns at least one row. `sql` should be an existence
 * probe (e.g. `SELECT 1 ... LIMIT 1`); the selected columns are ignored. Shared
 * by the per-(attendee, listing) and built-site assignment checks so the
 * row-presence boilerplate lives in one place.
 */
export const rowExists = async (
  sql: string,
  args: InValue[],
): Promise<boolean> => (await queryOne<unknown>(sql, args)) !== null;

/**
 * Build an existence check for "one leading id, matched against a list of ids".
 * The returned checker binds `leadingId` to the first `?` and expands `ids` into
 * the `IN (...)` your `buildSql` embeds via the placeholder string it receives.
 * Shared by the per-attendee "across these listings" probes so their signature
 * and args boilerplate live in one place. Empty `ids` still runs the query with
 * an empty `IN ()`, which matches nothing — callers pass a non-empty list.
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
  const row = await queryOne<{ n: number }>(
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
 * Combine several `{ sql, args }` pieces into one statement: the SQL fragments
 * joined with `joiner`, the args concatenated in the same order. For SQL built
 * from repeated sub-clauses (e.g. one capacity clause per day, joined with
 * `" AND "`).
 */
export const joinStatements = (
  statements: readonly SqlStatement[],
  joiner: string,
): SqlStatement => ({
  args: statements.flatMap((statement) => statement.args),
  sql: statements.map((statement) => statement.sql).join(joiner),
});

/** Join SQL conditions with AND while preserving their argument order. */
export const andConditions = (
  conditions: readonly SqlStatement[],
): SqlStatement => ({
  args: conditions.flatMap((condition) => condition.args),
  sql: conditions.map((condition) => `(${condition.sql})`).join(" AND "),
});

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
): Promise<ResultSet[]> => {
  const sqls = statements.map(({ sql }) => sql);
  // Batch writes serialize against the single SQLite writer like any other write,
  // so a contended batch waits and retries (then surfaces DatabaseBusyError)
  // rather than throwing raw SQLITE_BUSY — matching execute() and withTransaction.
  const results = await trackSql(sqls, () =>
    retryOnDatabaseLock(() => getDb().batch(statements, mode)),
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
  await runBatch(statements, "write", false);
};

/** Create a batch executor for a given transaction mode */
const batchFor =
  (mode: TransactionMode) =>
  (statements: SqlStatement[]): Promise<ResultSet[]> =>
    runBatch(statements, mode, true);

/** Execute multiple read queries in a single round-trip using Turso batch API. */
export const queryBatch = batchFor("read");

/**
 * Run read queries pinned to the primary in a single round-trip.
 *
 * libsql routes "read"-mode batches to a replica that can lag behind a
 * just-committed write, so a caller that must read its own writes (the
 * migrator verifying DDL it just applied) uses "write" mode, which Turso
 * always serves from the primary. A write-mode transaction may contain only
 * SELECTs — it just guarantees the primary, read-your-writes connection.
 */
export const queryBatchPrimary = batchFor("write");

/**
 * Execute multiple write statements and return their ResultSets.
 * Statements run in order within a single transaction (Turso batch API).
 * Ideal for cascading deletes and multi-step writes.
 */
export const executeBatchWithResults = batchFor("write");

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

/** The callback {@link withTransaction} runs inside the write transaction: it
 *  issues statements through its {@link TxScope} and resolves to a result. */
type TransactionWork<T> = (tx: TxScope) => Promise<T>;

/**
 * Run `work` in one freshly-begun interactive write transaction, committing on
 * success and rolling back on any error. Cache invalidations fire once after a
 * successful commit (a rollback fires none). A write lock lost while beginning or
 * committing throws SQLITE_BUSY, which {@link withTransaction} treats as
 * retryable; every other error propagates.
 */
const runWriteTransactionOnce = async <T>(
  work: TransactionWork<T>,
): Promise<T> => {
  const tx = await getDb().transaction("write");
  const writtenSql: string[] = [];
  let statementCount = 0;
  const scope: TxScope = {
    batch: (statements) => {
      const sqls = statements.map((statement) =>
        typeof statement === "string" ? statement : statement.sql,
      );
      writtenSql.push(...sqls);
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, sqls.join("; "));
      return trackSql(sqls, () => tx.batch(statements));
    },
    execute: (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      writtenSql.push(sql);
      // Guard against a transaction that holds the write lock open for too many
      // sequential round-trips (the "Transaction timed-out" shape); chatty writes
      // belong in a batch, not an interactive transaction.
      statementCount += 1;
      enforceTransactionRoundTripGuard(statementCount, sql);
      // Track transactional statements too, so reads inside the callback still
      // show in the debug footer and count toward the N+1 guard.
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

/** Every interactive write transaction shares the one libsql connection, so two
 *  that overlap can leave a statement in progress at the other's commit ("cannot
 *  commit transaction - SQL statements in progress") or lose the write lock.
 *  Chaining each transaction through this promise serialises them — one runs
 *  begin-to-commit before the next begins — the in-process realisation of
 *  SQLite's single writer, turning would-be contention into an orderly wait.
 *  A `const` holder (not a module-level `let`) carries the mutable tail. */
const writeQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

/**
 * Run `work` inside one interactive write transaction, committing on success and
 * rolling back (then rethrowing) on any error. Use this — rather than a plain
 * batch — when a multi-step write needs conditional logic between steps, e.g.
 * create → check capacity → finalize, where a zero-row guard must abort and undo
 * everything.
 *
 * Concurrent calls serialise: each waits for the previous interactive
 * transaction to settle before it begins, so two never overlap on the shared
 * connection (the documented "concurrent writers serialise rather than failing
 * the loser"). A genuinely contended lock — e.g. a non-transactional read racing
 * the commit — is still retried a few times with backoff (each retry re-runs
 * `work` on a fresh transaction, the prior attempt having rolled back), and a
 * database that stays locked surfaces as {@link DatabaseBusyError}. Statements run
 * through the provided `execute` are tracked, and their table-scoped cache
 * invalidations fire once after the commit succeeds — so callers get the same
 * automatic invalidation as the single-statement `execute`, driven by the writes
 * themselves rather than by each call site remembering to invalidate.
 */
export const withTransaction = <T>(work: TransactionWork<T>): Promise<T> => {
  // The async body runs synchronously up to its first await — reading the prior
  // tail there — so reserving our slot (`writeQueue.tail = run`) before any other
  // call interleaves keeps the queue strictly ordered. We wait for the previous
  // transaction however it settled (`.catch` swallows its failure — that is its
  // own caller's concern), then run, retrying a contended lock on a fresh tx.
  const run = (async (): Promise<T> => {
    await writeQueue.tail.catch(() => undefined);
    return retryOnDatabaseLock(() => runWriteTransactionOnce(work));
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
 * Write one row `statement` in a fresh write transaction and run `persist` (the
 * coupled join-table writes) on the same `tx`, so the row and its side writes
 * commit or roll back together. Returns the row id — `existingId` on update, or
 * the INSERT's `lastInsertRowid` on create (`existingId` null). Shared by the
 * REST resource (HTML forms) and CRUD API write paths.
 */
export const writeRowInTransaction = (
  statement: InStatement,
  existingId: number | null,
  persist: (tx: TxScope, id: number) => Promise<void>,
): Promise<number> =>
  withTransaction(async (tx) => {
    const res = await tx.execute(statement);
    const id = existingId ?? Number(res.lastInsertRowid);
    await persist(tx, id);
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
 * Build an INSERT statement from a table name and column→value record.
 *
 * ```ts
 * insert("users", { name: "Alice", admin_level: encLevel })
 * // → { sql: "INSERT INTO users (name, admin_level) VALUES (?, ?)",
 * //     args: ["Alice", encLevel] }
 *
 * insert("listing_attendees", {
 *   listing_id: 1,
 *   attendee_id: rawSql("last_insert_rowid()"),
 *   quantity: 2,
 * })
 * // → { sql: "INSERT INTO listing_attendees (...) VALUES (?, last_insert_rowid(), ?)",
 * //     args: [1, 2] }
 * ```
 */
export const insert = (
  table: string,
  values: Record<string, InValue | RawSql>,
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

  return {
    args,
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(
      ", ",
    )})`,
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
 * Build an UPDATE statement from a table name, a column→value record for the
 * SET clause, and a column→value record for the WHERE clause (equality checks,
 * ANDed together). The counterpart of {@link insert} — use it instead of
 * hand-writing the `UPDATE … SET … WHERE …` string when every condition is a
 * plain `column = value` match; a write that needs a richer guard (`IS NULL`,
 * an inequality, a subquery) keeps its own SQL. SET values may be
 * {@link rawSql} expressions (e.g. a counter increment).
 *
 * ```ts
 * update("attendees", { pii_blob: encrypted }, { id: 4 })
 * // → { sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
 * //     args: [encrypted, 4] }
 *
 * update(
 *   "listing_attendees",
 *   { attachment_downloads: rawSql("attachment_downloads + 1") },
 *   { attendee_id: 1, listing_id: 2 },
 * )
 * // → { sql: "UPDATE listing_attendees SET attachment_downloads = attachment_downloads + 1
 * //           WHERE attendee_id = ? AND listing_id = ?", args: [1, 2] }
 * ```
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
