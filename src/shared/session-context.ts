/**
 * Request-scoped session memoization via AsyncLocalStorage
 *
 * Caches the result of getAuthenticatedSession so that multiple calls
 * within the same request (e.g. routeAdmin pre-check + route handler)
 * only hit the database once.
 */

import type { AuthSession } from "#routes/auth.ts";
import { createScope } from "#shared/request-scoped.ts";

/** Sentinel value distinguishing "resolved to null" from "not yet resolved" */
type SessionState = { value: AuthSession | null; resolved: boolean };

const sessionScope = createScope<SessionState>();

/** Run a function within a session-memoization scope */
export const runWithSessionContext = <T>(fn: () => T): T =>
  sessionScope.run({ resolved: false, value: null }, fn);

/** Return the cached session if already resolved, or undefined if not yet resolved */
export const getCachedSession = (): AuthSession | null | undefined => {
  const state = sessionScope.current();
  if (!state?.resolved) return;
  return state.value;
};

/** Store the resolved session in the current request scope */
export const setCachedSession = (session: AuthSession | null): void => {
  const state = sessionScope.current();
  if (state) {
    state.value = session;
    state.resolved = true;
  }
};
