/**
 * Shared pieces of the per-IP attempt tables (`login_attempts`,
 * `token_attempts`). Both key their rows by a hashed IP and lock the IP out
 * until a timestamp, so the lockout check (with expired-row cleanup) and the
 * row clear live here once; each table keeps its own counting rules.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { deleteByField } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";

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
  await deleteByField(table, "ip", hashedIp);
  return false;
};
