/**
 * Sessions table operations
 */

import { registerCache, registerCacheReset } from "#shared/cache-registry.ts";
import { hashSessionToken } from "#shared/crypto/hashing.ts";
import type { WrappedKey } from "#shared/crypto/sealed.ts";
import {
  deleteByField,
  execute,
  insert,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";

import type { Session } from "#shared/types.ts";

/**
 * Session cache with TTL (10 seconds)
 * Reduces DB queries for repeated session lookups within the TTL window.
 * Cache entries: { session, cachedAt }
 */
const SESSION_CACHE_TTL_MS = 10_000;
type CacheEntry = { session: Session | null; cachedAt: number };
const sessionCache = new Map<string, CacheEntry>();

registerCache(() => ({ entries: sessionCache.size, name: "sessions" }));

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

  // Also check if the session itself has expired
  if (entry.session && Date.now() > entry.session.expires) {
    sessionCache.delete(token);
    return undefined;
  }

  return entry.session;
};

/**
 * Cache a session lookup result
 */
const cacheSession = (token: string, session: Session | null): void => {
  sessionCache.set(token, { cachedAt: Date.now(), session });
};

/**
 * Invalidate a session from cache
 */
const invalidateSessionCache = (token: string): void => {
  sessionCache.delete(token);
};

/**
 * Clear the entire session cache. Writes invalidate entry-by-entry, so no
 * table registration covers this cache — the reset hook keeps full resets and
 * restores able to clear it without importing this module.
 */
export const resetSessionCache = (): void => {
  sessionCache.clear();
};

registerCacheReset(resetSessionCache);

/**
 * Create a new session with CSRF token, wrapped data key, and user ID
 * Token is hashed before storage for security
 */
export const createSession = async (
  token: string,
  csrfToken: string,
  expires: number,
  wrappedDataKey: WrappedKey | null,
  userId: number,
): Promise<void> => {
  const tokenHash = await hashSessionToken(token);
  const session = {
    csrf_token: csrfToken,
    expires,
    token: tokenHash,
    user_id: userId,
    wrapped_data_key: wrappedDataKey,
  };
  const { sql, args } = insert("sessions", session);
  await execute(sql, args);
  // Pre-cache the new session using token hash as key
  cacheSession(tokenHash, session);
};

/** The sessions columns selected by the by-token and list reads. */
const SESSION_COLUMNS = "token, csrf_token, expires, wrapped_data_key, user_id";

/**
 * Get a session by token (with 10s TTL cache)
 * Token is hashed for database lookup
 */
export const getSession = async (token: string): Promise<Session | null> => {
  const tokenHash = await hashSessionToken(token);

  // Check cache first (using hash as key)
  const cached = getCachedSession(tokenHash);
  if (cached !== undefined) return cached;

  // Query DB and cache result (token column contains the hash)
  const session = await queryOne<Session>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`,
    [tokenHash],
  );
  cacheSession(tokenHash, session);
  return session;
};

/**
 * Delete a session by token
 * Token is hashed before database lookup
 */
export const deleteSession = async (token: string): Promise<void> => {
  const tokenHash = await hashSessionToken(token);
  invalidateSessionCache(tokenHash);
  await deleteByField("sessions", "token", tokenHash);
};

/**
 * Delete all sessions (used when password is changed)
 */
export const deleteAllSessions = async (): Promise<void> => {
  resetSessionCache();
  await execute("DELETE FROM sessions");
};

/**
 * Get all sessions ordered by expiration (newest first)
 */
export const getAllSessions = (): Promise<Session[]> =>
  queryAll<Session>(
    `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY expires DESC`,
  );

/**
 * Delete all sessions except the current one
 * Token is hashed before database comparison
 */
export const deleteOtherSessions = async (
  currentToken: string,
): Promise<void> => {
  const tokenHash = await hashSessionToken(currentToken);

  // Clear cache except for current token hash
  const currentEntry = sessionCache.get(tokenHash);
  resetSessionCache();
  if (currentEntry) {
    sessionCache.set(tokenHash, currentEntry);
  }

  await execute("DELETE FROM sessions WHERE token != ?", [tokenHash]);
};
