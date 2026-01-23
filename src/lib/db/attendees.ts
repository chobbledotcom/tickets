/**
 * Attendees table operations
 */

import { map } from "#fp";
import { decrypt, encrypt } from "#lib/crypto.ts";
import { getDb, queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";
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
 * Decrypt attendee fields
 */
const decryptAttendee = async (row: Attendee): Promise<Attendee> => {
  const name = await decrypt(row.name);
  const email = await decrypt(row.email);
  const stripe_payment_id = row.stripe_payment_id
    ? await decrypt(row.stripe_payment_id)
    : null;
  return { ...row, name, email, stripe_payment_id };
};

/**
 * Get attendees for an event (decrypted)
 */
export const getAttendees = async (eventId: number): Promise<Attendee[]> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    args: [eventId],
  });
  const rows = result.rows as unknown as Attendee[];
  return Promise.all(map(decryptAttendee)(rows));
};

/**
 * Create a new attendee (reserve tickets)
 * Sensitive fields (name, email, stripe_payment_id) are encrypted at rest
 */
export const createAttendee = async (
  eventId: number,
  name: string,
  email: string,
  stripePaymentId: string | null = null,
  quantity = 1,
): Promise<Attendee> => {
  const created = new Date().toISOString();
  const encryptedName = await encrypt(name);
  const encryptedEmail = await encrypt(email);
  const encryptedPaymentId = stripePaymentId
    ? await encrypt(stripePaymentId)
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
 * Get an attendee by ID (decrypted)
 */
export const getAttendee = async (id: number): Promise<Attendee | null> => {
  const row = await queryOne<Attendee>("SELECT * FROM attendees WHERE id = ?", [
    id,
  ]);
  return row ? decryptAttendee(row) : null;
};

/**
 * Update attendee's Stripe payment ID (encrypted at rest)
 */
export const updateAttendeePayment = async (
  attendeeId: number,
  stripePaymentId: string,
): Promise<void> => {
  const encryptedPaymentId = await encrypt(stripePaymentId);
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
