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
 * Get attendees for an event (decrypted)
 * Requires private key for decryption - only available to authenticated sessions
 */
export const getAttendees = async (
  eventId: number,
  privateKey: CryptoKey,
): Promise<Attendee[]> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    args: [eventId],
  });
  const rows = result.rows as unknown as Attendee[];
  return Promise.all(map((row: Attendee) => decryptAttendee(row, privateKey))(rows));
};

/**
 * Create a new attendee (reserve tickets)
 * Sensitive fields (name, email) are encrypted with the public key
 * No authentication required - public key is available for encryption
 */
export const createAttendee = async (
  eventId: number,
  name: string,
  email: string,
  stripePaymentId: string | null = null,
  quantity = 1,
): Promise<Attendee> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) {
    throw new Error("Encryption key not configured. Please complete setup.");
  }

  const created = new Date().toISOString();
  const encryptedName = await encryptAttendeePII(name, publicKeyJwk);
  const encryptedEmail = await encryptAttendeePII(email, publicKeyJwk);
  const encryptedPaymentId = stripePaymentId
    ? await encryptAttendeePII(stripePaymentId, publicKeyJwk)
    : null;
  const result = await getDb().execute({
    sql: "INSERT INTO attendees (event_id, name, email, created, stripe_payment_id, quantity) VALUES (?, ?, ?, ?, ?, ?)",
    args: [
      eventId,
      encryptedName,
      encryptedEmail,
      created,
      encryptedPaymentId,
      quantity,
    ],
  });
  return {
    id: Number(result.lastInsertRowid),
    event_id: eventId,
    name,
    email,
    created,
    stripe_payment_id: stripePaymentId,
    quantity,
  };
};

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, event_id, quantity are plaintext)
 */
export const getAttendeeRaw = async (id: number): Promise<Attendee | null> => {
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
 * Update attendee's Stripe payment ID (encrypted at rest)
 * Uses public key encryption - no authentication required
 */
export const updateAttendeePayment = async (
  attendeeId: number,
  stripePaymentId: string,
): Promise<void> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) {
    throw new Error("Encryption key not configured");
  }
  const encryptedPaymentId = await encryptAttendeePII(
    stripePaymentId,
    publicKeyJwk,
  );
  await getDb().execute({
    sql: "UPDATE attendees SET stripe_payment_id = ? WHERE id = ?",
    args: [encryptedPaymentId, attendeeId],
  });
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
