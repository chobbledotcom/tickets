/** The durable work item that carries a paid booking's registration
 * notification to whichever delivery can finish it. The row is born beside
 * the booking in the creation batch. A committed booking always has its
 * payload: the ticket token and the typed free texts. The payload is
 * sealed with DB_ENCRYPTION_KEY. The row key is the HMAC of the session
 * id.
 *
 * The lease is the atomic ownership boundary for the notification. One
 * `claimed_at` stamp lives per row. A claimant that goes stale loses it,
 * so two deliveries cannot both notify. `delivered_at` is the registration
 * completion marker. It exists even for bookings with no questions.
 */

import type { ResultSet } from "@libsql/client";
/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { ATTENDEE_BY_TOKEN_SQL } from "#db/attendees/create-batch.ts";
import { execute, queryOne, type SqlStatement } from "#db/client.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { isoBefore, nowIso } from "#shared/now.ts";
import {
  defineStoredJson,
  stringRecordSchema,
} from "#shared/validation/stored-json.ts";
/* jscpd:ignore-end */

/** What the notification needs that the database does not hold in the
 * clear. The buyer's ticket token, and the typed free texts the staged row
 * held. */
export type RegistrationWorkPayload = {
  ticketToken: string;
  freeTexts?: Record<string, string> | undefined;
};

const registrationWorkJson = defineStoredJson(
  v.object({
    freeTexts: v.optional(stringRecordSchema),
    ticketToken: v.string(),
  }),
);

/** The stored payload of one work row, read back from its sealed column. */
export const readRegistrationPayload = async (
  sealed: string,
): Promise<RegistrationWorkPayload> =>
  registrationWorkJson.read(
    await decrypt(sealed as EnvKeyEncrypted),
    "registration notification work",
  );

/** Seal a payload for the work row. The migration's backfill seals the empty
 * payload its delivered rows carry, so the helper is shared. */
export const sealedRegistrationPayload = (
  payload: RegistrationWorkPayload,
): Promise<string> =>
  encrypt(
    registrationWorkJson.write(payload, "registration notification work"),
  );

/** The batch statement that births the work item beside its booking: a
 * committed booking always has its payload. A retry of the same checkout
 * keeps the first row, because a session is paid once. The attendee id
 * resolves from the booking batch's own attendee insert, so the row names
 * the booking it belongs to and dies with it. */
export const registrationWorkStatements = (
  prepared: PreparedRegistrationWork,
  tokenIndex: string,
): SqlStatement[] => [
  {
    // The second placeholder sits inside the attendee subquery, so the token
    // index binds before the payload and the stamps.
    args: [prepared.sessionIndex, tokenIndex, prepared.sealed, nowIso()],
    sql: `INSERT INTO registration_notification_work
                (session_index, attendee_id, sealed, created_at)
              VALUES (?, (${ATTENDEE_BY_TOKEN_SQL}), ?, ?)
              ON CONFLICT(session_index) DO NOTHING`,
  },
];

/** The row's lookup key and sealed payload, prepared before the booking
 * batch runs, so the batch tail itself stays synchronous. */
export interface PreparedRegistrationWork {
  sealed: string;
  sessionIndex: string;
}

export const prepareRegistrationWork = async (
  sessionId: string,
  payload: RegistrationWorkPayload,
): Promise<PreparedRegistrationWork> => ({
  sealed: await sealedRegistrationPayload(payload),
  sessionIndex: await hmacHash(sessionId),
});

/** What the claim found for one session.
 *  - `claimed`: this delivery owns the notification and must run it, then
 *    mark it delivered or release the lease for the next one.
 *  - `delivered`: the notification already committed. Nothing to do.
 *  - `owned`: a live delivery holds the lease. It finishes the tail.
 *  - `null`: no row — a booking that predates the table, or a payload that
 *    was never sealed. The caller decides what its own surface can still
 *    recover. */
export type RegistrationWorkClaim =
  | { kind: "claimed"; payload: RegistrationWorkPayload }
  | { kind: "delivered" }
  | { kind: "owned" };

interface StoredWorkRow {
  delivered_at: string | null;
  sealed: string;
}

/** The claim a lease statement's outcome decides: a returned row carries the
 * row's own sealed payload, and no row leaves the decision to the caller. */
const leasedClaim = async (
  rows: ResultSet["rows"],
): Promise<RegistrationWorkClaim | null> => {
  const first = rows[0];
  if (first === undefined) return null;
  return {
    kind: "claimed",
    payload: await readRegistrationPayload(String(first.sealed)),
  };
};

/** Lease the session's notification work. The conditional update wins
 * exactly once per notification. It steals the lease only when a dead
 * claimant holds it past the stale-reservation clock. Returns null when
 * the session has no work row: a booking that predates the table. Its
 * caller then decides what its own surface can still recover. */
export const claimRegistrationWorkOrNull = async (
  sessionId: string,
): Promise<RegistrationWorkClaim | null> => {
  const sessionIndex = await hmacHash(sessionId);
  const leased = await execute(
    `UPDATE registration_notification_work
        SET claimed_at = ?
      WHERE session_index = ? AND delivered_at IS NULL
        AND (claimed_at IS NULL OR claimed_at < ?)
      RETURNING sealed`,
    [nowIso(), sessionIndex, isoBefore(STALE_RESERVATION_MS)],
  );
  const claimed = await leasedClaim(leased.rows);
  if (claimed) return claimed;
  const row = await queryOne<StoredWorkRow>(
    "SELECT sealed, delivered_at FROM registration_notification_work WHERE session_index = ?",
    [sessionIndex],
  );
  if (row === null) return null;
  return row.delivered_at === null ? { kind: "owned" } : { kind: "delivered" };
};

/** Lease the session's notification work for a booking that was born with a
 * work row. A missing row is a state no flow can produce, so it throws. */
export const claimRegistrationWork = async (
  sessionId: string,
): Promise<RegistrationWorkClaim> => {
  const claim = await claimRegistrationWorkOrNull(sessionId);
  if (claim === null) {
    throw new Error(
      `Booking session (index ${await hmacHash(sessionId)}) has no registration notification work row`,
    );
  }
  return claim;
};

/** Lease the session's notification work, creating the row when it is
 * missing. The insert's winner owns the notification. A loser reads the
 * actual row the winner created, held or delivered. */
export const claimOrInsertRegistrationWork = async (
  sessionId: string,
  payload: RegistrationWorkPayload,
): Promise<RegistrationWorkClaim> => {
  const existing = await claimRegistrationWorkOrNull(sessionId);
  if (existing) return existing;
  await insertRegistrationWorkClaim(sessionId, payload);
  // The row exists either way now: this delivery created it unclaimed, or a
  // competing delivery created it and holds its claim.
  return claimRegistrationWork(sessionId);
};

/** Insert the session's work row unclaimed, for a session whose row was
 * never born beside the booking. A competing insert for the same session
 * loses to the existing row, because the session is one notification. */
export const insertRegistrationWorkClaim = async (
  sessionId: string,
  payload: RegistrationWorkPayload,
): Promise<void> => {
  await execute(
    `INSERT INTO registration_notification_work
                (session_index, sealed, created_at)
              VALUES (?, ?, ?)
              ON CONFLICT(session_index) DO NOTHING`,
    [
      await hmacHash(sessionId),
      await sealedRegistrationPayload(payload),
      nowIso(),
    ],
  );
};

/** Run the claimed notification, then stamp it delivered. The stamp is the
 * registration completion marker: it lands only after the awaited
 * notification returns. A replay that finds it skips nothing a buyer is
 * still owed. A failed notification gives the lease back, so the redelivery
 * that the rethrow causes claims fresh. */
export const markRegistrationWorkDelivered = async (
  sessionId: string,
): Promise<void> => {
  await execute(
    "UPDATE registration_notification_work SET delivered_at = ? WHERE session_index = ?",
    [nowIso(), await hmacHash(sessionId)],
  );
};

/** Run the claimed notification, then stamp it delivered. The stamp is the
 * registration completion marker: it lands only after the awaited
 * notification returns. A replay that finds it skips nothing a buyer is
 * still owed. A failed notification gives the lease back, so the redelivery
 * that the rethrow causes claims fresh. */
export const deliverRegistrationWork = async (
  sessionId: string,
  deliver: () => Promise<void>,
): Promise<void> => {
  await deliver().catch(async (error) => {
    await releaseRegistrationWork(sessionId);
    throw error;
  });
  await markRegistrationWorkDelivered(sessionId);
};

/** Give the lease back after a failed notification, so the very next
 * delivery can claim it instead of waiting out the stale clock. */
export const releaseRegistrationWork = async (
  sessionId: string,
): Promise<void> => {
  await execute(
    "UPDATE registration_notification_work SET claimed_at = NULL WHERE session_index = ? AND delivered_at IS NULL",
    [await hmacHash(sessionId)],
  );
};

/** The payload's free-text record, as the notification's answer map. */
export const payloadFreeTexts = (
  payload: RegistrationWorkPayload,
): FreeTextAnswers | undefined =>
  payload.freeTexts === undefined
    ? undefined
    : new Map(
        Object.entries(payload.freeTexts).map(([questionId, text]) => [
          Number(questionId),
          text,
        ]),
      );

/** The payload's free-text record, from the notification's answer map. */
export const freeTextsRecord = (
  freeTexts: FreeTextAnswers,
): Record<string, string> =>
  Object.fromEntries(
    [...freeTexts].map(([questionId, text]) => [String(questionId), text]),
  );
