/**
 * Attendees table operations
 *
 * PII (name, email, stripe_payment_id) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import { map } from "#fp";
import { decryptAttendeePII, encryptAttendeePII } from "#lib/crypto.ts";
import { getDb, queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { getPublicKey } from "#lib/db/settings.ts";
import { col, defineTable } from "#lib/db/table.ts";
import type { Attendee } from "#lib/types.ts";

/**
 * Minimal attendees table for deleteById operation
 */
const attendeesTable = defineTable<Pick<Attendee, "id">, object>({
  name: "attendees",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
  },
});

/**
 * Decrypt attendee fields using the private key
 * Requires authenticated session with access to private key
 */
const decryptAttendee = async (
  row: Attendee,
  privateKey: CryptoKey,
): Promise<Attendee> => {
  const name = await decryptAttendeePII(row.name, privateKey);
  const email = await decryptAttendeePII(row.email, privateKey);
  const stripe_payment_id = row.stripe_payment_id
    ? await decryptAttendeePII(row.stripe_payment_id, privateKey)
    : null;
  return { ...row, name, email, stripe_payment_id };
};

/**
 * Get attendees for an event without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = async (eventId: number): Promise<Attendee[]> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    args: [eventId],
  });
  return result.rows as unknown as Attendee[];
};

/**
 * Decrypt a list of raw attendees.
 * Used when attendees are fetched via batch query.
 */
export const decryptAttendees = (
  rows: Attendee[],
  privateKey: CryptoKey,
): Promise<Attendee[]> =>
  Promise.all(map((row: Attendee) => decryptAttendee(row, privateKey))(rows));

/**
 * Decrypt a single raw attendee, handling null input.
 * Used when attendee is fetched via batch query.
 */
export const decryptAttendeeOrNull = (
  row: Attendee | null,
  privateKey: CryptoKey,
): Promise<Attendee | null> =>
  row ? decryptAttendee(row, privateKey) : Promise.resolve(null);


/** Encrypted attendee data for insertion */
type EncryptedAttendeeData = {
  created: string;
  encryptedName: string;
  encryptedEmail: string;
  encryptedPaymentId: string | null;
};

/** Encrypt attendee fields, returning null if key not configured */
const encryptAttendeeFields = async (
  name: string,
  email: string,
  stripePaymentId: string | null,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) return null;

  return {
    created: new Date().toISOString(),
    encryptedName: await encryptAttendeePII(name, publicKeyJwk),
    encryptedEmail: await encryptAttendeePII(email, publicKeyJwk),
    encryptedPaymentId: stripePaymentId
      ? await encryptAttendeePII(stripePaymentId, publicKeyJwk)
      : null,
  };
};

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (
  insertId: number | bigint | undefined,
  eventId: number,
  name: string,
  email: string,
  created: string,
  stripePaymentId: string | null,
  quantity: number,
): Attendee => ({
  id: Number(insertId ?? 0),
  event_id: eventId,
  name,
  email,
  created,
  stripe_payment_id: stripePaymentId,
  quantity,
});

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, event_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>("SELECT * FROM attendees WHERE id = ?", [id]);
};

/**
 * Get an attendee by ID (decrypted)
 * Requires private key for decryption - only available to authenticated sessions
 */
export const getAttendee = async (
  id: number,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const row = await getAttendeeRaw(id);
  return row ? decryptAttendee(row, privateKey) : null;
};

/**
 * Delete an attendee (for cleanup on payment failure)
 */
export const deleteAttendee = (attendeeId: number): Promise<void> =>
  attendeesTable.deleteById(attendeeId);

/**
 * Check if event has available spots for given quantity
 */
export const hasAvailableSpots = async (
  eventId: number,
  quantity = 1,
): Promise<boolean> => {
  const event = await getEventWithCount(eventId);
  if (!event) return false;
  return event.attendee_count + quantity <= event.max_attendees;
};

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendee: Attendee }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  /**
   * Atomically create attendee with capacity check in single SQL statement.
   * Prevents race conditions by combining check and insert.
   */
  createAttendeeAtomic: async (
    eventId: number,
    name: string,
    email: string,
    paymentId: string | null = null,
    qty = 1,
  ): Promise<CreateAttendeeResult> => {
    const enc = await encryptAttendeeFields(name, email, paymentId);
    if (!enc) {
      return { success: false, reason: "encryption_error" };
    }

    // Atomic check-and-insert: only inserts if capacity allows
    const insertResult = await getDb().execute({
      sql: `INSERT INTO attendees (event_id, name, email, created, stripe_payment_id, quantity)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE (
              SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ?
            ) + ? <= (
              SELECT max_attendees FROM events WHERE id = ?
            )`,
      args: [
        eventId,
        enc.encryptedName,
        enc.encryptedEmail,
        enc.created,
        enc.encryptedPaymentId,
        qty,
        eventId,
        qty,
        eventId,
      ],
    });

    if (insertResult.rowsAffected === 0) {
      return { success: false, reason: "capacity_exceeded" };
    }

    return {
      success: true,
      attendee: buildAttendeeResult(
        insertResult.lastInsertRowid,
        eventId,
        name,
        email,
        enc.created,
        paymentId,
        qty,
      ),
    };
  },
};

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const createAttendeeAtomic = (
  evtId: number,
  n: string,
  e: string,
  pId: string | null = null,
  q = 1,
): Promise<CreateAttendeeResult> => attendeesApi.createAttendeeAtomic(evtId, n, e, pId, q);
