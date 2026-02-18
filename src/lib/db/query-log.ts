/**
 * Request-scoped SQL query logging for the owner debug footer.
 *
 * Call `enableQueryLog()` at the start of a request and `getQueryLog()`
 * after the response body has been built to retrieve every tracked query.
 */

/** A single logged query */
export type QueryLogEntry = { sql: string; durationMs: number };

/** Mutable state held in a const object to satisfy the no-let lint rule */
const state: { enabled: boolean; entries: QueryLogEntry[] } = {
  enabled: false,
  entries: [],
};

/** Enable query logging and clear previous entries */
export const enableQueryLog = (): void => {
  state.enabled = true;
  state.entries = [];
};

/** Disable query logging and clear entries */
export const disableQueryLog = (): void => {
  state.enabled = false;
  state.entries = [];
};

/** Whether query logging is currently active */
export const isQueryLogEnabled = (): boolean => state.enabled;

/** Record a query (no-op when logging is disabled) */
export const addQueryLogEntry = (sql: string, durationMs: number): void => {
  if (state.enabled) state.entries.push({ sql, durationMs });
};

/** Return a snapshot of all logged queries */
export const getQueryLog = (): QueryLogEntry[] => [...state.entries];

/** Run an async DB operation and log it when tracking is active */
export const trackQuery = async <T>(
  sql: string,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!state.enabled) return fn();
  const start = performance.now();
  const result = await fn();
  state.entries.push({ sql, durationMs: performance.now() - start });
  return result;
};
