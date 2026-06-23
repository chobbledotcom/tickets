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
  type TransactionMode,
} from "@libsql/client";
import { lazyRef } from "#fp";
import {
  invalidateCachesForWrite,
  type WriteVerb,
} from "#shared/cache-registry.ts";
import {
  addQueryLogEntry,
  isQueryLogEnabled,
  logCompletedSql,
  trackQuery,
} from "#shared/db/query-log.ts";
import { getEnv } from "#shared/env.ts";
import { delay } from "#shared/now.ts";

/**
 * Match the target table of a mutating statement (INSERT/UPDATE/DELETE/REPLACE),
 * the mirror of query-log's read detector. Anchored at the start so it fails
 * fast on the SELECTs that dominate the call volume. The optional
 * `OR <action>` / `OR <action> INTO` clauses cover libsql's conflict variants.
 */
const WRITE_TABLE_RE =
  /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`]?(\w+)/i;

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
  const match = WRITE_TABLE_RE.exec(sql);
  if (!match) return;
  const table = match[1]!.toLowerCase();
  const firstWord = sql.trimStart().split(/\s/)[0]!.toLowerCase();
  const verb: WriteVerb =
    firstWord === "delete" || firstWord === "update" || firstWord === "replace"
      ? (firstWord as WriteVerb)
      : "insert";
  if (verb === "update") {
    const columns = extractUpdateColumns(sql);
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
  return createClient({
    authToken: getEnv("DB_TOKEN"),
    url,
  });
};

const [dbGetter, dbSetter] = lazyRef(createDbClient);

/**
 * Get or create database client
 */
export const getDb = (): Client => dbGetter();

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
export class DatabaseBusyError extends Error {
  constructor() {
    super("the database is too busy to complete this write");
    this.name = "DatabaseBusyError";
  }
}

/** Backoff before each retry of a contended database lock; its length is the
 *  number of retries, so four attempts in total. */
const WRITE_LOCK_RETRY_BACKOFF_MS = [50, 150, 350] as const;
const WRITE_LOCK_ATTEMPTS = WRITE_LOCK_RETRY_BACKOFF_MS.length + 1;

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
const retryOnDatabaseLock = async <T>(run: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < WRITE_LOCK_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(WRITE_LOCK_RETRY_BACKOFF_MS[attempt - 1]!);
    try {
      return await run();
    } catch (error) {
      if (!isDatabaseLocked(error)) throw error;
    }
  }
  throw new DatabaseBusyError();
};

const executeTrackedStatement = (
  sql: string,
  args?: InValue[],
): Promise<ResultSet> =>
  trackQuery(sql, () =>
    retryOnDatabaseLock(() =>
      args ? getDb().execute({ args, sql }) : getDb().execute(sql),
    ),
  );

/**
 * Run a single statement: track it for the query log / N+1 guard, then fire any
 * table-scoped cache invalidation. Every single-statement read and write goes
 * through here (queryOne/queryAll wrap it), so cache invalidation is driven by
 * the write itself rather than by each call site remembering to invalidate.
 */
export const execute = async (
  sql: string,
  args?: InValue[],
): Promise<ResultSet> => {
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
export const executeWithoutCacheInvalidation = async (
  sql: string,
  args?: InValue[],
): Promise<ResultSet> => executeTrackedStatement(sql, args);

/** Query single row, returning null if not found */
export const queryOne = async <T>(
  sql: string,
  args: InValue[],
): Promise<T | null> => {
  const rows = resultRows<T>(await execute(sql, args));
  return rows.length === 0 ? null : rows[0]!;
};

/** Query all rows, returning a typed array */
export const queryAll = async <T>(
  sql: string,
  args?: InValue[],
): Promise<T[]> => resultRows<T>(await execute(sql, args));

/** Count all rows in a table. `table` must be a trusted constant, not input. */
export const countRows = async (table: string): Promise<number> => {
  // COUNT(*) always returns exactly one row, so the result is never null.
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}`,
    [],
  );
  return row!.n;
};

/** Delete rows matching a field value */
export const deleteByField = async (
  table: string,
  field: string,
  value: InValue,
): Promise<void> => {
  await execute(`DELETE FROM ${table} WHERE ${field} = ?`, [value]);
};

/** Delete rows from multiple tables in a single batch transaction */
export const deleteByFieldBatch = (
  deletes: Array<{ table: string; field: string; value: InValue }>,
): Promise<void> =>
  executeBatch(
    deletes.map(({ table, field, value }) => ({
      args: [value],
      sql: `DELETE FROM ${table} WHERE ${field} = ?`,
    })),
  );

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
 * Execute a batch with optional query logging, then invalidate caches for every
 * table the batch mutated. Invalidation runs once the transaction has
 * committed; if the batch throws (rollback) it is skipped, so a cache is never
 * cleared for a write that did not land.
 */
const trackedBatch = async (
  statements: Array<{ sql: string; args: InValue[] }>,
  mode: TransactionMode,
): Promise<ResultSet[]> => {
  const start = performance.now();
  // Batch writes serialize against the single SQLite writer like any other write,
  // so a contended batch waits and retries (then surfaces DatabaseBusyError)
  // rather than throwing raw SQLITE_BUSY — matching execute() and withTransaction.
  const results = await retryOnDatabaseLock(() =>
    getDb().batch(statements, mode),
  );
  if (isQueryLogEnabled()) {
    const elapsed = performance.now() - start;
    // Every statement shares the one round-trip window [start, start+elapsed],
    // so the footer's wall-clock union counts that time once (not N times).
    for (const stmt of statements) addQueryLogEntry(stmt.sql, elapsed, start);
  }
  for (const stmt of statements) {
    logCompletedSql(stmt.sql);
    invalidateForSql(stmt.sql);
  }
  return results;
};

/** Create a batch executor for a given transaction mode */
const batchFor =
  (mode: TransactionMode) =>
  (statements: Array<{ sql: string; args: InValue[] }>): Promise<ResultSet[]> =>
    trackedBatch(statements, mode);

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
  statements: Array<{ sql: string; args: InValue[] }>,
): Promise<void> => {
  await executeBatchWithResults(statements);
};

/** The slice of an open write transaction handed to a {@link withTransaction}
 *  callback: run statements with `execute`; commit/rollback are managed for you. */
export type TxScope = {
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
  const scope: TxScope = {
    execute: (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      writtenSql.push(sql);
      // Track transactional statements too, so reads inside the callback still
      // show in the debug footer and count toward the N+1 guard.
      return trackQuery(sql, () => tx.execute(stmt));
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
