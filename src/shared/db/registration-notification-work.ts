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

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
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

const sealedRegistrationPayload = (
  payload: RegistrationWorkPayload,
): Promise<string> =>
  encrypt(
    registrationWorkJson.write(payload, "registration notification work"),
  );

/** The batch statement that births the work item beside its booking: a
 * committed booking always has its payload. A retry of the same checkout
 * keeps the first row, because a session is paid once. */
export const registrationWorkStatements = async (
  sessionId: string,
  payload: RegistrationWorkPayload,
): Promise<SqlStatement[]> => [
  {
    args: [
      await hmacHash(sessionId),
      await sealedRegistrationPayload(payload),
      nowIso(),
    ],
    sql: `INSERT INTO registration_notification_work
                (session_index, sealed, created_at)
              VALUES (?, ?, ?)
              ON CONFLICT(session_index) DO NOTHING`,
  },
];

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
  if (leased.rows.length > 0) {
    return {
      kind: "claimed",
      payload: await readRegistrationPayload(String(leased.rows[0]!.sealed)),
    };
  }
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

/** Insert one work row as this delivery's own claim, for a session whose
 * row was never born beside the booking. */
export const insertRegistrationWorkClaim = async (
  sessionId: string,
  payload: RegistrationWorkPayload,
): Promise<void> => {
  await execute(
    `INSERT INTO registration_notification_work
                (session_index, sealed, claimed_at, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(session_index) DO NOTHING`,
    [
      await hmacHash(sessionId),
      await sealedRegistrationPayload(payload),
      nowIso(),
      nowIso(),
    ],
  );
};

/** Commit the notification: the registration completion marker. */
export const markRegistrationWorkDelivered = async (
  sessionId: string,
): Promise<void> => {
  await execute(
    "UPDATE registration_notification_work SET delivered_at = ? WHERE session_index = ?",
    [nowIso(), await hmacHash(sessionId)],
  );
};

/** Run the claimed notification, then stamp it delivered. A notification
 * that fails gives the lease back, so the redelivery this failure causes
 * claims the work instead of waiting out the stale clock. */
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
