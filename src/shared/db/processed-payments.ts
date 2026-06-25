/**
 * Processed payments table operations (idempotency for webhook handling)
 *
 * Uses a two-phase locking pattern to prevent duplicate attendee creation:
 * 1. reserveSession() - Claims the session with NULL attendee_id
 * 2. createBookingAtomic() with batchFinalizeStatement() inside the same batch
 *    - Creates the attendee and sets attendee_id atomically, closing the crash
 *    window between creation and a separate finalize call.
 * 3. (webhook only) setSessionTicketTokens() - Persists replay tokens.
 *
 * If reserveSession fails (session already claimed), we check if it's:
 * - Finalized (attendee_id set) → return success with existing attendee
 * - Still processing (attendee_id NULL) → check staleness
 *   - Stale (>5min old) → delete and retry (process likely crashed)
 *   - Fresh → return conflict error (still being processed)
 */

import type { InValue } from "@libsql/client";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { execute, insert, queryOne } from "#shared/db/client.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { nowIso, nowMs } from "#shared/now.ts";

export { STALE_RESERVATION_MS };

/**
 * A processed_payments row is in exactly one of three lifecycle states, encoded
 * across two columns: **reserved** (in-progress: attendee_id NULL, no
 * failure_data), **finalized** (success: attendee_id set), **failed** (terminal
 * handled failure: attendee_id NULL, failure_data set). These two predicates are
 * the single source of truth for that shape — every query/branch that
 * distinguishes the states derives from them (or {@link isUnresolvedReservation})
 * so the encoding can't drift between call sites.
 */
const UNRESOLVED_RESERVATION = "attendee_id IS NULL AND failure_data = ''";
/** Complement of {@link UNRESOLVED_RESERVATION}: a finalized success or a
 * recorded terminal failure. Exported for the pruner, which reaps resolved rows. */
export const RESOLVED_OUTCOME =
  "(attendee_id IS NOT NULL OR failure_data != '')";

/** Processed payment record */
export type ProcessedPayment = {
  payment_session_id: string;
  attendee_id: number | null;
  processed_at: string;
  ticket_tokens: string;
  /** Encrypted JSON-encoded {@link StoredPaymentFailure} once a session reaches a
   * handled terminal failure (refund issued, sold out, price changed, …); "" while
   * a row is in-progress or finalized. Encrypted at rest (like ticket_tokens)
   * because the stored message can embed an encrypted-at-rest listing name. Lets a
   * later redirect/webhook replay the same outcome instead of re-running refund
   * logic. */
  failure_data: string;
};

/**
 * The subset of a handled payment failure we persist so a later redirect or
 * webhook retry replays the same terminal result (user-facing message, HTTP
 * status, and whether a refund was already issued) without re-validating the
 * listing or re-attempting the refund.
 *
 * Persisted encrypted (see {@link markSessionFailed} / failure_data): `error`
 * can embed an encrypted-at-rest listing name, so it must never be stored in the
 * clear. Keep this shape free of any field that shouldn't round-trip through the
 * DB encryption key.
 */
export type StoredPaymentFailure = {
  error: string;
  status?: number;
  refunded?: boolean;
};

/** Result of session reservation attempt */
export type ReserveSessionResult =
  | { reserved: true }
  | { reserved: false; existing: ProcessedPayment };

/**
 * Check if a payment session has already been processed
 */
export const isSessionProcessed = (
  sessionId: string,
): Promise<ProcessedPayment | null> =>
  queryOne<ProcessedPayment>(
    "SELECT payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

/**
 * Check if a reservation is stale (abandoned by a crashed process)
 */
export const isReservationStale = (processedAt: string): boolean => {
  const reservedAt = new Date(processedAt).getTime();
  return nowMs() - reservedAt > STALE_RESERVATION_MS;
};

/** True when a row is an in-progress reservation with no recorded outcome — the
 * in-memory mirror of the {@link UNRESOLVED_RESERVATION} SQL predicate. */
export const isUnresolvedReservation = (row: ProcessedPayment): boolean =>
  row.attendee_id === null && row.failure_data === "";

/** Execute a SQL statement parameterized by a single payment session ID */
const execWithSessionId = (sessionId: string, sql: string): Promise<unknown> =>
  execute(sql, [sessionId]);

/**
 * Release an in-progress reservation so the very next delivery can re-claim it.
 * Deletes only a still-unresolved row, so it never clobbers a finalized success
 * or a recorded terminal failure that a racing delivery may have written.
 *
 * Two callers:
 *  - {@link reserveSession} releases a *stale* reservation (abandoned by a
 *    crashed process) before retrying the claim.
 *  - the webhook releases a *fresh* reservation whose refund of a real payment
 *    just failed: recording no outcome but holding the lock would make the next
 *    redelivery collide and return 409 until the row goes stale (~5 min),
 *    gating refund recovery on a local timer instead of provider redelivery.
 */
export const releaseReservation = async (sessionId: string): Promise<void> => {
  await execWithSessionId(
    sessionId,
    `DELETE FROM processed_payments WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
  );
};

/**
 * Delete all stale reservations (unfinalized, outcome-less, and older than
 * STALE_RESERVATION_MS). Called from admin listing views to clean up abandoned
 * checkouts. Rows carrying a recorded terminal failure are kept so a late
 * redirect/webhook replays the handled outcome rather than re-refunding.
 */
export const deleteAllStaleReservations = async (): Promise<number> => {
  const cutoff = new Date(nowMs() - STALE_RESERVATION_MS).toISOString();
  const result = await execute(
    `DELETE FROM processed_payments WHERE ${UNRESOLVED_RESERVATION} AND processed_at < ?`,
    [cutoff],
  );
  return result.rowsAffected;
};

/**
 * Reserve a payment session for processing (first phase of two-phase lock)
 * Inserts with NULL attendee_id to claim the session.
 * Returns { reserved: true } if we claimed it, or { reserved: false, existing } if already claimed.
 *
 * Handles abandoned reservations: if an existing reservation has NULL attendee_id
 * and is older than STALE_RESERVATION_MS, we assume the process crashed and
 * delete the stale record to allow retry.
 */
export const reserveSession = async (
  sessionId: string,
): Promise<ReserveSessionResult> => {
  try {
    const { sql, args } = insert("processed_payments", {
      attendee_id: null,
      payment_session_id: sessionId,
      processed_at: nowIso(),
    });
    await execute(sql, args);
    return { reserved: true };
  } catch (e) {
    const errorMsg = String(e);
    if (
      errorMsg.includes("UNIQUE constraint") ||
      errorMsg.includes("PRIMARY KEY constraint")
    ) {
      // Session already claimed - get existing record (must exist: UNIQUE error proves it)
      const existing = (await isSessionProcessed(sessionId))!;

      // Check if reservation is stale (abandoned by crashed process). A row
      // carrying a recorded terminal failure is never stale — it is replayed
      // by the caller instead of being deleted and re-processed.
      if (
        isUnresolvedReservation(existing) &&
        isReservationStale(existing.processed_at)
      ) {
        // Release the abandoned row and retry the claim. This recurses at most
        // one extra level: any row present after the delete must have been
        // inserted at ~now (by this retry or a racing request), so it is fresh
        // — isReservationStale is false for it and we fall through to the
        // conflict return rather than looping.
        await releaseReservation(sessionId);
        return reserveSession(sessionId);
      }

      return { existing, reserved: false };
    }
    throw e;
  }
};

/** Encrypt a list of ticket tokens for storage, joining with "+". */
const encryptTicketTokens = (ticketTokens: string[]): Promise<string> =>
  encrypt(ticketTokens.join("+"));

/**
 * Finalize a reserved session with the created attendee ID (second phase)
 */
export const finalizeSession = async (
  sessionId: string,
  attendeeId: number,
  ticketTokens: string[],
): Promise<void> => {
  await execute(
    "UPDATE processed_payments SET attendee_id = ?, ticket_tokens = ? WHERE payment_session_id = ?",
    [attendeeId, await encryptTicketTokens(ticketTokens), sessionId],
  );
};

/**
 * Heal a still-unresolved reservation by stamping `attendee_id`, leaving
 * `ticket_tokens` untouched. The ledger-replay path uses this: when a late
 * delivery finds the booking already recorded in the ledger, it points its fresh
 * reservation row at the existing attendee so the next delivery takes the fast
 * already-processed path — but ONLY while the row is unresolved, so it never
 * overwrites the `attendee_id` or blanks the `ticket_tokens` a racing delivery
 * may have just finalized and stored. Guarded on {@link UNRESOLVED_RESERVATION}
 * (the first outcome wins), and a no-op if the row was pruned away.
 */
export const finalizeSessionIfUnresolved = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments SET attendee_id = ? WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [attendeeId, sessionId],
  );
};

/**
 * Record a handled terminal failure on a still-unresolved session. A later
 * redirect/webhook for the same session reads this back via
 * {@link parseSessionFailure} and returns the same outcome, so refunds and
 * validation never run twice. Guarded on {@link UNRESOLVED_RESERVATION}, so it
 * never clobbers a finalized success and never overwrites an already-recorded
 * failure (the first outcome wins); a no-op if the row was pruned away.
 */
export const markSessionFailed = async (
  sessionId: string,
  failure: StoredPaymentFailure,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments SET failure_data = ? WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [await encrypt(JSON.stringify(failure)), sessionId],
  );
};

/** Generic terminal failure used when stored failure_data can't be parsed. */
const CORRUPT_FAILURE: StoredPaymentFailure = {
  error: "This payment could not be completed. Please contact support.",
  status: 500,
};

/**
 * Parse a stored terminal failure, or null when the row carries none. We only
 * ever write valid encrypted JSON (via {@link markSessionFailed}), but a value
 * that won't decrypt or parse (restore, manual edit, rotated key) must not crash
 * the replay path — it degrades to a generic terminal failure so the session
 * still resolves instead of looping.
 */
export const parseSessionFailure = async (
  failureData: string,
): Promise<StoredPaymentFailure | null> => {
  if (!failureData) return null;
  try {
    return JSON.parse(await decrypt(failureData)) as StoredPaymentFailure;
  } catch {
    return CORRUPT_FAILURE;
  }
};

/** A built SQL statement: the text and its positional bind args. */
type SqlStatement = { sql: string; args: InValue[] };

/** Shared UPDATE shape for the finalize statement builders. */
const buildFinalizeStatement = (
  attendeeId: number,
  sessionId: string,
  guard: string,
  extraArgs: InValue[] = [],
): SqlStatement => ({
  args: [attendeeId, sessionId, ...extraArgs],
  sql: `UPDATE processed_payments SET attendee_id = ?, ticket_tokens = '' WHERE payment_session_id = ? AND ${guard}`,
});

/**
 * Build the finalize UPDATE for the single-batch booking path, where the
 * attendee row is inserted earlier in the SAME batch so its id isn't a literal
 * yet: `attendee_id` is set from `attendeeIdSql` (the in-batch `MAX(id)`
 * subquery), and the row is finalized only while still unresolved AND `guard`
 * confirms the whole booking landed. Keeping finalize in the booking batch
 * preserves the invariant that `attendee_id` is set atomically with the attendee
 * INSERT — closing the duplicate-attendee crash window a separate finalize would
 * reopen. ticket_tokens is '' (persisted afterwards by setSessionTicketTokens). */
export const batchFinalizeStatement = (
  sessionId: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  guard: SqlStatement,
): SqlStatement => ({
  args: [attendeeIdArg, sessionId, ...guard.args],
  sql: `UPDATE processed_payments SET attendee_id = ${attendeeIdSql}, ticket_tokens = ''
        WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION} AND ${guard.sql}`,
});

/**
 * Build the finalize UPDATE for a balance-payment session, guarded so it only
 * applies while the attendee's balance still equals the amount being settled.
 * Returned rather than executed so the caller can commit it in the SAME batch as
 * the balance settle — closing the crash window between settle and finalize that
 * would otherwise leave a paid-but-unfinalized row (which a stale-replay could
 * then wrongly refund). Balance sessions carry no ticket tokens.
 */
export const balanceFinalizeStatement = (
  sessionId: string,
  attendeeId: number,
  expectedAmount: number,
): SqlStatement =>
  // Guarded on the ledger-projected outstanding balance (no stored column).
  // Runs in the settle batch before the balance-payment leg, so it still sees
  // the pre-payment balance — i.e. the attendee owing exactly expectedAmount. A
  // no-real-line attendee owes 0 ≠ expectedAmount, so the finalize is skipped and
  // the session stays unresolved for the failure log.
  buildFinalizeStatement(
    attendeeId,
    sessionId,
    `${attendeeOwedSubquery(String(attendeeId))} = ?`,
    [expectedAmount],
  );

/**
 * Store encrypted ticket tokens on an already-finalized session so later
 * webhook replays can return them. Separated from batchFinalizeStatement so
 * token encryption never holds the write lock open. No-op if the session was
 * pruned.
 */
export const setSessionTicketTokens = async (
  sessionId: string,
  ticketTokens: string[],
): Promise<void> => {
  await execute(
    "UPDATE processed_payments SET ticket_tokens = ? WHERE payment_session_id = ?",
    [await encryptTicketTokens(ticketTokens), sessionId],
  );
};

/**
 * Decrypt the ticket_tokens field from a processed payment record.
 * Returns the plaintext token string (e.g. "tok1+tok2") or empty string.
 */
export const decryptSessionTokens = async (
  encryptedTokens: string,
): Promise<string> => {
  if (!encryptedTokens) return "";
  return await decrypt(encryptedTokens);
};

/**
 * Clear stored ticket tokens for a session (after redirect has consumed them)
 */
export const clearSessionTokens = async (sessionId: string): Promise<void> => {
  await execWithSessionId(
    sessionId,
    "UPDATE processed_payments SET ticket_tokens = '' WHERE payment_session_id = ?",
  );
};

/**
 * Get the attendee ID for an already-processed session
 * Used to return success for idempotent webhook retries
 */
export const getProcessedAttendeeId = async (
  sessionId: string,
): Promise<number | null> => {
  const result = await isSessionProcessed(sessionId);
  return result?.attendee_id ?? null;
};
