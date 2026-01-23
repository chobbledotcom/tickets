/**
 * Sessions table operations
 */

import type { Session } from "../types.ts";
import { executeByField, getDb, queryOne } from "./client.ts";

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
