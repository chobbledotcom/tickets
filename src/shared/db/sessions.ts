/**
 * Sessions table operations
 */

import { hashSessionToken } from "#crypto/hashing.ts";
import type { WrappedKey } from "#crypto/sealed.ts";
import {
  deleteByField,
  execute,
  insert,
  queryAll,
  queryOne,
} from "#db/client.ts";
import { createPrimaryCacheRefill } from "#db/primary-reads.ts";
import type { UserAuthFields } from "#db/users.ts";
import { ttlCache } from "#fp";
import {
  type CacheInvalidation,
  registerCache,
  registerTableInvalidation,
} from "#shared/cache-registry.ts";
import { requireValue } from "#shared/required-value.ts";

import type { Session } from "#types";

/**
 * Session cache with TTL (10 seconds)
 * Reduces DB queries for repeated session lookups within the TTL window.
 * The entry cap matters here: misses are cached too (a null entry per unknown
 * token), so without it a flood of unique junk cookies would grow the map
 * without bound.
 */
const SESSION_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX_ENTRIES = 1000;
const sessionCache = ttlCache<string, Session | null>(
  SESSION_CACHE_TTL_MS,
  () => Date.now(),
  SESSION_CACHE_MAX_ENTRIES,
);
const primaryRefill = createPrimaryCacheRefill();

registerCache(() => ({ entries: sessionCache.size(), name: "sessions" }));

/**
 * Get cached session if still valid
 */
const getCachedSession = (token: string): Session | null | undefined => {
  const entry = sessionCache.get(token);
  // A session that expired mid-window is a miss: the DB read that follows
  // overwrites the entry, so it is not served again.
  if (entry && Date.now() > entry.expires) return;
  return entry;
};

/**
 * Cache a session lookup result
 */
const cacheSession = (token: string, session: Session | null): void => {
  sessionCache.set(token, session);
};

/**
 * Clear the entire session cache. Table registration also keeps full resets,
 * restores, and writes able to clear it without importing this module.
 */
const resetSessionCache = (cause: CacheInvalidation = "manual"): void => {
  sessionCache.clear();
  primaryRefill.afterInvalidation(cause === "write");
};

registerTableInvalidation(["sessions"], resetSessionCache);

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
const SESSION_COLUMN_NAMES = [
  "token",
  "csrf_token",
  "expires",
  "wrapped_data_key",
  "user_id",
] as const;

const SESSION_COLUMNS = SESSION_COLUMN_NAMES.join(", ");

/** The same columns read through a join, where the table carries an alias. */
const sessionColumnsOn = (alias: string): string =>
  SESSION_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");

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
  const session = await primaryRefill.fetch(() =>
    queryOne<Session>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`,
      [tokenHash],
    ),
  );
  cacheSession(tokenHash, session);
  return session;
};

/** A session and the user it belongs to. `user` is null when the session
 * outlived its user, which the caller reports and clears — never mistake it for
 * a token nobody ever had. */
export type SessionWithUser = {
  readonly session: Session;
  readonly user: UserAuthFields | null;
};

/** The joined row: session columns, plus the user's if one still exists. */
type SessionUserRow = Session & {
  user_row_id: number | null;
  admin_level: UserAuthFields["admin_level"] | null;
};

const joinedUser = (row: SessionUserRow): UserAuthFields | null =>
  row.user_row_id === null
    ? null
    : {
        admin_level: requireValue(
          row.admin_level,
          `Session user ${row.user_row_id} has no admin level`,
        ),
        id: row.user_row_id,
      };

/**
 * Read a session and the user it belongs to together.
 *
 * Authenticating needs both, and the user id is only known once the session has
 * been read, so as two reads they can never overlap — on a cold edge server
 * that is two waits before the page can start. A session whose user has since
 * been deleted still comes back, so the caller can tell that apart from an
 * unknown token and clear the stale row.
 *
 * The user's admin level decides what the viewer may do, so it is read afresh
 * every time and never served from the session cache.
 */
export const getSessionWithUser = async (
  token: string,
): Promise<SessionWithUser | null> => {
  const tokenHash = await hashSessionToken(token);
  const row = await primaryRefill.fetch(() =>
    queryOne<SessionUserRow>(
      `SELECT ${sessionColumnsOn("session")},
              adminUser.id AS user_row_id, adminUser.admin_level
         FROM sessions AS session
         LEFT JOIN users AS adminUser ON adminUser.id = session.user_id
        WHERE session.token = ?`,
      [tokenHash],
    ),
  );
  if (row === null) {
    cacheSession(tokenHash, null);
    return null;
  }
  const { admin_level: _level, user_row_id: _userRowId, ...session } = row;
  cacheSession(tokenHash, session);
  return { session, user: joinedUser(row) };
};

/**
 * Delete a session by token
 * Token is hashed before database lookup
 */
export const deleteSession = async (token: string): Promise<void> => {
  const tokenHash = await hashSessionToken(token);
  await deleteByField("sessions", "token", tokenHash);
};

/**
 * Delete all sessions (used when password is changed)
 */
export const deleteAllSessions = async (): Promise<void> => {
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
  const currentSession = await getSession(currentToken);
  await execute("DELETE FROM sessions WHERE token != ?", [tokenHash]);

  // The write invalidation clears every entry; the unchanged current session
  // can be restored without another database read.
  cacheSession(tokenHash, currentSession);
};
