/**
 * Request-scoped SQL logging for the admin debug footer, plus an N+1 read
 * guard.
 *
 * The guard counts reads by their SQL text. Because queries are parameterized,
 * a per-row lookup loop runs the *same* string N times, which is the N+1
 * signature, whether the loop is sequential or fanned out with Promise.all.
 *
 * Crossing the threshold throws in dev and test, and reports via the error log
 * in production. A batched read is one round-trip and never reaches the guard.
 */

import { lazyRef, map, pipe, reduce, sort } from "#fp";
import { withLazyLogger } from "#shared/lazy-logger.ts";
import { shouldSuppressDebugLogs } from "#shared/log-settings.ts";
import { createScope } from "#shared/request-scoped.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  countSubrequest,
} from "#shared/subrequest-budget.ts";

/** A single logged query */
export type QueryLogEntry = {
  sql: string;
  durationMs: number;
  /**
   * `performance.now()` captured when the query started. Stored so the footer
   * can report the *wall-clock* time the request spent in SQL — the union of
   * overlapping query intervals — instead of naively summing durations. Summing
   * double-counts queries that ran concurrently (`Promise.all`) and statements
   * folded into a single batch round-trip, which both overlap in real time.
   */
  startedAtMs: number;
};

type QueryLogState = {
  databaseRoundTrips: number;
  enabled: boolean;
  entries: QueryLogEntry[];
  startTime: number;
  /**
   * Whether the admin debug footer may render the captured queries. Separate
   * from `enabled` (which only controls *recording*): recording is turned on
   * early — before the route's settings load, so that query is captured — but
   * the footer is staff-only and gated on this flag, set after auth.
   */
  footerVisible: boolean;
  /** Per-request count of each read SQL string, for the N+1 guard */
  readCounts: Map<string, number>;
};

const freshState = (): QueryLogState => ({
  databaseRoundTrips: 0,
  enabled: false,
  entries: [],
  footerVisible: false,
  readCounts: new Map(),
  startTime: 0,
});

const queryLogScope = createScope<QueryLogState>();
const fallbackState: QueryLogState = freshState();

// A request context the runtime leaked past its own end reads as "outside a
// request" (see createScope) — its counters and entries must not absorb
// later, unrelated work.
const getState = (): QueryLogState => queryLogScope.current() ?? fallbackState;

export const runWithQueryLogContext = <T>(fn: () => T): T =>
  queryLogScope.run(freshState(), fn);

/** Whether database calls are currently subject to Bunny's per-request cap. */
export const isDatabaseRoundTripLimited = (): boolean =>
  queryLogScope.current() !== undefined;

/** Enable query logging and clear previous entries */
export const enableQueryLog = (): void => {
  const state = getState();
  state.enabled = true;
  state.entries = [];
  state.startTime = performance.now();
};

/** Allow the admin debug footer to render the captured queries (staff-only). */
export const enableFooterDebug = (): void => {
  getState().footerVisible = true;
};

/** Whether the admin debug footer may render the captured queries. */
export const isFooterDebugEnabled = (): boolean => getState().footerVisible;

/** Return the start time recorded by enableQueryLog() */
export const getQueryLogStartTime = (): number => getState().startTime;

/** Return a snapshot of all logged queries */
export const getQueryLog = (): QueryLogEntry[] => [...getState().entries];

/** A query's [start, end) window on the `performance.now()` clock. */
type Interval = readonly [start: number, end: number];

/** Reduce accumulator: the open interval being extended, plus settled total. */
type MergedSpan = { total: number; start: number; end: number };

/**
 * Wall-clock milliseconds during which at least one query was in flight: the
 * combined length of the query intervals with overlaps merged.
 *
 * Summing `durationMs` answers "how much query work ran" but double-counts
 * concurrency, so it is wrong as a measure of how long the request *waited* on
 * the database. Reads fanned out with `Promise.all` overlap in wall-clock time,
 * and every statement in a `queryBatch` shares one round-trip window; merging
 * overlaps counts that shared time once. Because every query runs within the
 * request, the result is always ≤ the render time, so `render − sqlWallClock`
 * is a non-negative "everything that wasn't SQL" figure.
 */
export const sqlWallClockMs = (entries: readonly QueryLogEntry[]): number => {
  if (entries.length === 0) return 0;
  const intervals: Interval[] = pipe(
    map(
      (e: QueryLogEntry): Interval => [
        e.startedAtMs,
        e.startedAtMs + e.durationMs,
      ],
    ),
    sort((a, b) => a[0] - b[0]),
  )(entries as QueryLogEntry[]);
  const [firstStart, firstEnd] = intervals[0]!;
  const merged = reduce(
    (span: MergedSpan, [start, end]: Interval): MergedSpan => {
      if (start > span.end) {
        // Disjoint from the open interval: settle it and open a new one.
        span.total += span.end - span.start;
        span.start = start;
        span.end = end;
      } else if (end > span.end) {
        // Overlapping or adjacent: extend the open interval.
        span.end = end;
      }
      return span;
    },
    { end: firstEnd, start: firstStart, total: 0 },
  )(intervals);
  return merged.total + (merged.end - merged.start);
};

/**
 * Max times one parameterized read may run as a separate round-trip within a
 * single request before the N+1 guard fires. Set above the worst legitimate
 * repeat in the suite; lower it to catch smaller N+1s.
 */
export const N_PLUS_ONE_THRESHOLD = 25;

/**
 * Every statement inside a `withTransaction` holds the single primary write
 * connection open for another edge→primary round-trip. A chatty interactive
 * transaction is what the primary aborts as "Transaction timed-out".
 *
 * A plain batch is one round-trip however many statements it carries, and is
 * never counted. Pushing chatty writes onto it is the whole point.
 *
 * Anything growing with input size must prepare its reads outside the lock and
 * apply its writes as one batch. The high-water mark is recreateTable on
 * attendee_answers at 27 statements, and this sits above that.
 */
export const TRANSACTION_ROUNDTRIP_THRESHOLD = 30;

/** Count one actual libsql client call and stop before call 51 reaches the
 * network. Unlike advisory N+1 reporting, this stays hard in production because
 * Bunny would reject the same request immediately afterwards anyway. */
/**
 * `enforceBudget: false` exempts the call from the *budget* allowance only — the
 * reserve/allowance cap the migration runner sets below the real limit. The hard
 * round-trip limit below always applies: it mirrors Bunny's platform cap, which
 * no call, cleanup included, can exceed. So a rollback is let past our own
 * stricter reserve to run, but is still blocked if it would be a genuine
 * over-the-platform-limit subrequest — exactly as Bunny would reject it.
 */
export const countDatabaseRoundTrip = (
  operation: string,
  enforceBudget = true,
): void => {
  countSubrequest("database", operation, enforceBudget);
  const state = queryLogScope.current();
  if (!state) return;
  state.databaseRoundTrips += 1;
  if (state.databaseRoundTrips <= BUNNY_SUBREQUEST_LIMIT) return;
  throw new Error(
    `Database round-trip limit exceeded: ${state.databaseRoundTrips} calls ` +
      `(limit ${BUNNY_SUBREQUEST_LIMIT}) in one request. ` +
      `Blocked operation: ${operation}`,
  );
};

/**
 * When true, an N+1 violation is reported via the error log instead of thrown.
 * Production (`src/edge.ts`) opts in so a real request is never killed; dev and
 * tests stay in throw mode so the offending request fails loudly. Pass `null`
 * to reset to the default (throw).
 */
const [getN1NotifyOnly, setN1NotifyOnly] = lazyRef<boolean>(() => false);

/** Switch the N+1 guard between throw (default) and notify-only (production). */
export const setN1GuardNotifyOnly = (value: boolean | null): void =>
  setN1NotifyOnly(value);

/** Only single-statement reads are the N+1-prone shape we count. */
const isReadSql = (sql: string): boolean => /^\s*(?:with|select)\b/i.test(sql);

/**
 * Report a violation without a static `logger` import — query-log is imported by
 * the db client, which the logger transitively depends on, so a static import
 * would form a cycle. The dynamic import mirrors `env.ts`'s `isReadOnly`.
 */
const notifyN1Violation = (detail: string): Promise<void> =>
  withLazyLogger(({ ErrorCode, logError }) =>
    logError({ code: ErrorCode.DB_QUERY, detail }),
  );

/**
 * Mirror the debug footer to the system logs: emit each SQL statement as it
 * completes, with its bound values omitted. The statement is parameterised, so
 * the string carries only `?` placeholders — never PII or secrets — exactly the
 * value-free view the admin footer renders. Whitespace is collapsed so a
 * multi-line statement logs on one line. Routed through `logDebug` (category
 * "SQL") so it honours the same debug-log suppression as other debug output;
 * the dynamic import avoids the static cycle (query-log is imported by the db
 * client, which the logger transitively depends on), mirroring
 * {@link notifyN1Violation}.
 */
export const logCompletedSql = async (sql: string): Promise<void> => {
  if (shouldSuppressDebugLogs()) return;
  const { logDebug } = await import("#shared/logger.ts");
  logDebug("SQL", sql.replace(/\s+/g, " ").trim());
};

/**
 * Count a read round-trip within a request and fire once, exactly when the
 * count crosses the threshold. Writes and queries outside a request scope (the
 * fallback state, e.g. startup migrations) are never counted.
 */
/**
 * Surface a guard violation: throw in dev/test (the offending request fails
 * loudly) or report via the error log in production (see
 * {@link setN1GuardNotifyOnly}, so production never kills a real request).
 * Shared by the N+1 read guard and the interactive-transaction round-trip guard.
 */
const reportGuardViolation = (detail: string): void => {
  if (getN1NotifyOnly()) {
    void notifyN1Violation(detail);
  } else {
    throw new Error(detail);
  }
};

const enforceN1Guard = (state: QueryLogState, sql: string): void => {
  if (!isReadSql(sql)) return;
  const count = (state.readCounts.get(sql) ?? 0) + 1;
  state.readCounts.set(sql, count);
  if (count !== N_PLUS_ONE_THRESHOLD + 1) return;
  reportGuardViolation(
    `N+1 query detected: same read ran ${count} times (limit ${N_PLUS_ONE_THRESHOLD}) in one request: ${sql}`,
  );
};

/**
 * Count a statement within one interactive transaction and fire once, exactly
 * when the running count crosses the threshold. Only enforced inside a request
 * scope — startup migrations rebuild tables in one big transaction outside any
 * request, so they are never counted. `count` is the running per-transaction
 * statement count.
 */
export const enforceTransactionRoundTripGuard = (
  count: number,
  sql: string,
): void => {
  if (!queryLogScope.current()) return;
  if (count !== TRANSACTION_ROUNDTRIP_THRESHOLD + 1) return;
  reportGuardViolation(
    `Interactive transaction too chatty: ${count} statements ` +
      `(limit ${TRANSACTION_ROUNDTRIP_THRESHOLD}) held the write lock open — ` +
      "prepare reads outside the transaction and apply the writes as one batch. " +
      `Last statement: ${sql}`,
  );
};

/**
 * Run an async DB operation, enforcing the N+1 read guard and logging it when
 * footer tracking is active.
 */
export const trackSql = async <T>(
  sql: string | string[],
  fn: () => Promise<T>,
): Promise<T> => {
  const store = queryLogScope.current();
  if (store && typeof sql === "string") enforceN1Guard(store, sql);
  const sqls = typeof sql === "string" ? [sql] : sql;
  const state = store ?? fallbackState;
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  if (state.enabled) {
    state.entries.push(
      ...sqls.map((sql) => ({ durationMs, sql, startedAtMs: start })),
    );
  }
  for (const sql of sqls) void logCompletedSql(sql);
  return result;
};
