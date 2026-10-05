/**
 * Request-scoped session memoization via AsyncLocalStorage
 *
 * Caches the result of getAuthenticatedSession so that multiple calls
 * within the same request (e.g. routeAdmin pre-check + route handler)
 * only hit the database once.
 */

import type { AuthSession } from "#routes/auth.ts";
import { currentRequestStore } from "#shared/request-context.ts";

/** Sentinel value distinguishing "resolved to null" from "not yet resolved" */
export type SessionState = { value: AuthSession | null; resolved: boolean };

/** Return the cached session if already resolved, or undefined if not yet resolved */
export const getCachedSession = (): AuthSession | null | undefined => {
  const state = currentRequestStore()?.session;
  if (!state?.resolved) return;
  return state.value;
};

/** Store the resolved session in the current request's store */
export const setCachedSession = (session: AuthSession | null): void => {
  const store = currentRequestStore();
  if (!store) return;
  store.session = { resolved: true, value: session };
};
