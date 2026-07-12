/**
 * Request-scoped session memoization via AsyncLocalStorage
 *
 * Caches the result of getAuthenticatedSession so that multiple calls
 * within the same request (e.g. routeAdmin pre-check + route handler)
 * only hit the database once.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthSession } from "#routes/auth.ts";
import {
  liveScopeStore,
  runWithScopeLifetime,
} from "#shared/request-scoped.ts";

/** Sentinel value distinguishing "resolved to null" from "not yet resolved" */
type SessionState = { value: AuthSession | null; resolved: boolean };

const sessionStore = new AsyncLocalStorage<SessionState>();

/** Run a function within a session-memoization scope */
export const runWithSessionContext = <T>(fn: () => T): T =>
  runWithScopeLifetime(sessionStore, { resolved: false, value: null }, fn);

/** Return the cached session if already resolved, or undefined if not yet resolved */
export const getCachedSession = (): AuthSession | null | undefined => {
  const state = liveScopeStore(sessionStore);
  if (!state?.resolved) return;
  return state.value;
};

/** Store the resolved session in the current request scope */
export const setCachedSession = (session: AuthSession | null): void => {
  const state = liveScopeStore(sessionStore);
  if (state) {
    state.value = session;
    state.resolved = true;
  }
};
