/**
 * Sessions table operations
 */

import { executeByField, getDb, queryOne } from "#lib/db/client.ts";
import type { Session } from "#lib/types.ts";

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
};

/**
 * Get a session by token
 */
export const getSession = async (token: string): Promise<Session | null> =>
  queryOne<Session>(
    "SELECT token, csrf_token, expires FROM sessions WHERE token = ?",
    [token],
  );

/**
 * Delete a session by token
 */
export const deleteSession = async (token: string): Promise<void> =>
  executeByField("sessions", "token", token);

/**
 * Delete all sessions (used when password is changed)
 */
export const deleteAllSessions = async (): Promise<void> => {
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
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE token != ?",
    args: [currentToken],
  });
};
