/**
 * Request-scoped SQL query logging for the admin debug footer, plus an N+1
 * read guard.
 *
 * Footer: call `enableQueryLog()` at the start of a request and `getQueryLog()`
 * after the response body has been built to retrieve every tracked query.
 *
 * N+1 guard: regardless of footer logging, every single-query read is counted
 * by its SQL within a request. Because queries are parameterized, a per-row
 * lookup loop runs the *same* SQL string N times — the N+1 signature — whether
 * the loop is sequential or fanned out with Promise.all. Crossing
 * `N_PLUS_ONE_THRESHOLD` throws in dev/test (so the request fails loudly) or, in
 * production, reports via the error log (see `setN1GuardNotifyOnly`). Batched
 * reads (`queryBatch`) are a single round-trip and never reach this guard.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { lazyRef } from "#fp";

/** A single logged query */
export type QueryLogEntry = { sql: string; durationMs: number };

type QueryLogState = {
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
  enabled: false,
  entries: [],
  footerVisible: false,
  readCounts: new Map(),
  startTime: 0,
});

const asyncLocalStorage = new AsyncLocalStorage<QueryLogState>();
const fallbackState: QueryLogState = freshState();

const getState = (): QueryLogState =>
  asyncLocalStorage.getStore() ?? fallbackState;

export const runWithQueryLogContext = <T>(fn: () => T): T =>
  asyncLocalStorage.run(freshState(), fn);

/** Enable query logging and clear previous entries */
export const enableQueryLog = (): void => {
  const state = getState();
  state.enabled = true;
  state.entries = [];
  state.startTime = performance.now();
};

/** Whether query logging is currently active */
export const isQueryLogEnabled = (): boolean => getState().enabled;

/** Allow the admin debug footer to render the captured queries (staff-only). */
export const enableFooterDebug = (): void => {
  getState().footerVisible = true;
};

/** Whether the admin debug footer may render the captured queries. */
export const isFooterDebugEnabled = (): boolean => getState().footerVisible;

/** Return the start time recorded by enableQueryLog() */
export const getQueryLogStartTime = (): number => getState().startTime;

/** Record a query (no-op when logging is disabled) */
export const addQueryLogEntry = (sql: string, durationMs: number): void => {
  const state = getState();
  if (state.enabled) state.entries.push({ durationMs, sql });
};

/** Return a snapshot of all logged queries */
export const getQueryLog = (): QueryLogEntry[] => [...getState().entries];

/**
 * Max times one parameterized read may run as a separate round-trip within a
 * single request before the N+1 guard fires. Set above the worst legitimate
 * repeat in the suite; lower it to catch smaller N+1s.
 */
export const N_PLUS_ONE_THRESHOLD = 25;

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
const notifyN1Violation = async (detail: string): Promise<void> => {
  const { ErrorCode, logError } = await import("#shared/logger.ts");
  logError({ code: ErrorCode.DB_QUERY, detail });
};

/**
 * Count a read round-trip within a request and fire once, exactly when the
 * count crosses the threshold. Writes and queries outside a request scope (the
 * fallback state, e.g. startup migrations) are never counted.
 */
const enforceN1Guard = (state: QueryLogState, sql: string): void => {
  if (!isReadSql(sql)) return;
  const count = (state.readCounts.get(sql) ?? 0) + 1;
  state.readCounts.set(sql, count);
  if (count !== N_PLUS_ONE_THRESHOLD + 1) return;
  const detail = `N+1 query detected: same read ran ${count} times (limit ${N_PLUS_ONE_THRESHOLD}) in one request: ${sql}`;
  if (getN1NotifyOnly()) {
    void notifyN1Violation(detail);
  } else {
    throw new Error(detail);
  }
};

/**
 * Run an async DB operation, enforcing the N+1 read guard and logging it when
 * footer tracking is active.
 */
export const trackQuery = async <T>(
  sql: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const store = asyncLocalStorage.getStore();
  if (store) enforceN1Guard(store, sql);
  const state = store ?? fallbackState;
  if (!state.enabled) return fn();
  const start = performance.now();
  const result = await fn();
  state.entries.push({ durationMs: performance.now() - start, sql });
  return result;
};
