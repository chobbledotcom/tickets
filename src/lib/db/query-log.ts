/**
 * Request-scoped SQL query logging for the owner debug footer.
 *
 * Call `enableQueryLog()` at the start of a request and `getQueryLog()`
 * after the response body has been built to retrieve every tracked query.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** A single logged query */
export type QueryLogEntry = { sql: string; durationMs: number };

type QueryLogState = { enabled: boolean; entries: QueryLogEntry[] };

const asyncLocalStorage = new AsyncLocalStorage<QueryLogState>();
const fallbackState: QueryLogState = { enabled: false, entries: [] };

const getState = (): QueryLogState => asyncLocalStorage.getStore() ?? fallbackState;

export const runWithQueryLogContext = <T>(
  fn: () => T,
): T => asyncLocalStorage.run({ enabled: false, entries: [] }, fn);

/** Enable query logging and clear previous entries */
export const enableQueryLog = (): void => {
  const state = getState();
  state.enabled = true;
  state.entries = [];
};

/** Disable query logging and clear entries */
export const disableQueryLog = (): void => {
  const state = getState();
  state.enabled = false;
  state.entries = [];
};

/** Whether query logging is currently active */
export const isQueryLogEnabled = (): boolean => getState().enabled;

/** Record a query (no-op when logging is disabled) */
export const addQueryLogEntry = (sql: string, durationMs: number): void => {
  const state = getState();
  if (state.enabled) state.entries.push({ sql, durationMs });
};

/** Return a snapshot of all logged queries */
export const getQueryLog = (): QueryLogEntry[] => [...getState().entries];

/** Run an async DB operation and log it when tracking is active */
export const trackQuery = async <T>(
  sql: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const state = getState();
  if (!state.enabled) return fn();
  const start = performance.now();
  const result = await fn();
  state.entries.push({ sql, durationMs: performance.now() - start });
  return result;
};
