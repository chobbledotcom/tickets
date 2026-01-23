/**
 * Sessions table operations
 */

import { executeByField, getDb, queryOne } from "#lib/db/client.ts";
import type { Session } from "#lib/types.ts";

/**
 * Session cache with TTL (10 seconds)
 * Reduces DB queries for repeated session lookups within the TTL window.
 * Cache entries: { session, cachedAt }
 */
const SESSION_CACHE_TTL_MS = 10_000;
type CacheEntry = { session: Session | null; cachedAt: number };
const sessionCache = new Map<string, CacheEntry>();

/**
 * Get cached session if still valid
 */
const getCachedSession = (token: string): Session | null | undefined => {
  const entry = sessionCache.get(token);
  if (!entry) return undefined;

  if (Date.now() - entry.cachedAt > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(token);
    return undefined;
  }

  return entry.session;
};

/**
 * Cache a session lookup result
 */
const cacheSession = (token: string, session: Session | null): void => {
  sessionCache.set(token, { session, cachedAt: Date.now() });
};

/**
 * Invalidate a session from cache
 */
const invalidateSessionCache = (token: string): void => {
  sessionCache.delete(token);
};

/**
 * Clear entire session cache
 */
const clearSessionCache = (): void => {
  sessionCache.clear();
};

/**
 * Clear session cache (exported for testing)
 */
export const resetSessionCache = (): void => {
  clearSessionCache();
};

/**
 * Create a new session with CSRF token
 */
export const createSession = async (
  token: string,
  csrfToken: string,
  expires: number,
): Promise<void> => {
  await getDb().execute({
    sql: "INSERT INTO sessions (token, csrf_token, expires) VALUES (?, ?, ?)",
    args: [token, csrfToken, expires],
  });
  // Pre-cache the new session
  cacheSession(token, { token, csrf_token: csrfToken, expires });
};

/**
 * Get a session by token (with 10s TTL cache)
 */
export const getSession = async (token: string): Promise<Session | null> => {
  // Check cache first
  const cached = getCachedSession(token);
  if (cached !== undefined) return cached;

  // Query DB and cache result
  const session = await queryOne<Session>(
    "SELECT token, csrf_token, expires FROM sessions WHERE token = ?",
    [token],
  );
  cacheSession(token, session);
  return session;
};

/**
 * Delete a session by token
 */
export const deleteSession = async (token: string): Promise<void> => {
  invalidateSessionCache(token);
  await executeByField("sessions", "token", token);
};

/**
 * Delete all sessions (used when password is changed)
 */
export const deleteAllSessions = async (): Promise<void> => {
  clearSessionCache();
  await getDb().execute("DELETE FROM sessions");
};

/**
 * Get all sessions ordered by expiration (newest first)
 */
export const getAllSessions = async (): Promise<Session[]> => {
  const result = await getDb().execute(
    "SELECT token, csrf_token, expires FROM sessions ORDER BY expires DESC",
  );
  return result.rows as unknown as Session[];
};

/**
 * Delete all sessions except the current one
 */
export const deleteOtherSessions = async (
  currentToken: string,
): Promise<void> => {
  // Clear cache except for current token
  const currentEntry = sessionCache.get(currentToken);
  clearSessionCache();
  if (currentEntry) {
    sessionCache.set(currentToken, currentEntry);
  }

  await getDb().execute({
    sql: "DELETE FROM sessions WHERE token != ?",
    args: [currentToken],
  });
};
