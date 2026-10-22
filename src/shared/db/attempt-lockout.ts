/**
 * Shared pieces of the per-IP attempt tables (`login_attempts`,
 * `token_attempts`). Both key their rows by a hashed IP and lock the IP out
 * until a timestamp, so the lockout check (with expired-row cleanup), the
 * atomic attempt recorder, and the row clear live here once; each table keeps
 * its own counting rules inside its own single-statement upsert.
 */

import { hmacHash } from "#crypto/hashing.ts";
import {
  deleteByField,
  execute,
  executeReturningRow,
  queryOne,
} from "#db/client.ts";
import {
  numberedStatement,
  type SqlParameter,
} from "#db/numbered-statement.ts";
import { nowMs } from "#shared/now.ts";

type StoredLockout = { locked_until: number | null };

/** Build a limiter's attempt recorder from its single-statement upsert,
 * written in the deferred numbered form: the builder binds each value once
 * and the binder hands every repeat of that value the same token, so the
 * numbering carries no prose map. The statement must count the attempt AND
 * decide the lockout inside the database (`INSERT … ON CONFLICT … RETURNING
 * locked_until`). Two attempts arriving at once can then never lose a count
 * the way a read-then-write sequence could. The recorder returns true when
 * the IP is now locked out. */
export const makeAttemptRecorder =
  <T>(
    buildSql: (bind: SqlParameter, values: T) => string,
  ): ((values: T) => Promise<boolean>) =>
  async (values: T): Promise<boolean> => {
    const { sql, args } = numberedStatement((bind) => buildSql(bind, values));
    return (
      (await executeReturningRow<StoredLockout>(sql, args)).locked_until !==
      null
    );
  };

/** Whether the IP's row in an attempts table holds an active lockout. Reads
 * only the lockout column; a missing row (no attempts yet) reads as not
 * limited, and an expired lockout is cleaned up on the way. */
export const isIpLockedOut = async (
  table: string,
  hashedIp: string,
): Promise<boolean> => {
  const row = await queryOne<StoredLockout>(
    `SELECT locked_until FROM ${table} WHERE ip = ?`,
    [hashedIp],
  );
  return lockoutActive(table, hashedIp, row?.locked_until);
};

/** Build the "forget this IP" action for an attempts table: delete the IP's
 * row (found by its one-way hash). Used on success so legitimate users leave
 * no fingerprint, and by tests to reset state. */
export const clearAttemptsFor =
  (table: string): ((ip: string) => Promise<void>) =>
  async (ip: string): Promise<void> =>
    deleteByField(table, "ip", await hmacHash(ip));

/** Whether a stored lockout is still active. No lockout (or no row) reads as
 * not limited; an expired lockout deletes the row so the next attempt starts
 * fresh. */
export const lockoutActive = async (
  table: string,
  hashedIp: string,
  lockedUntil: number | null | undefined,
): Promise<boolean> => {
  if (lockedUntil === null || lockedUntil === undefined) return false;
  if (lockedUntil > nowMs()) return true;
  // Delete only the exact lockout we read: a fresh one written by a
  // concurrent request has a different timestamp and must survive.
  await execute(`DELETE FROM ${table} WHERE ip = ? AND locked_until = ?`, [
    hashedIp,
    lockedUntil,
  ]);
  return false;
};
