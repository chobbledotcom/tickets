/**
 * Attendees table operations
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import { map } from "#fp";
import { decrypt, decryptAttendeePII, encrypt, encryptAttendeePII, generateTicketToken } from "#lib/crypto.ts";
import { getDb, inPlaceholders, queryOne } from "#lib/db/client.ts";
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
  const email = row.email
    ? await decryptAttendeePII(row.email, privateKey)
    : "";
  const phone = row.phone
    ? await decryptAttendeePII(row.phone, privateKey)
    : "";
  const payment_id = row.payment_id
    ? await decryptAttendeePII(row.payment_id, privateKey)
    : null;
  const price_paid = row.price_paid ? await decrypt(row.price_paid) : null;
  const checked_in = row.checked_in
    ? await decryptAttendeePII(row.checked_in, privateKey)
    : "false";
  return { ...row, name, email, phone, payment_id, price_paid, checked_in };
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
  encryptedPhone: string;
  encryptedPaymentId: string | null;
  encryptedPricePaid: string | null;
  encryptedCheckedIn: string;
};

/** Encrypt attendee fields, returning null if key not configured */
const encryptAttendeeFields = async (
  name: string,
  email: string,
  phone: string,
  paymentId: string | null,
  pricePaid: number | null,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) return null;

  return {
    created: new Date().toISOString(),
    encryptedName: await encryptAttendeePII(name, publicKeyJwk),
    encryptedEmail: email
      ? await encryptAttendeePII(email, publicKeyJwk)
      : "",
    encryptedPhone: phone
      ? await encryptAttendeePII(phone, publicKeyJwk)
      : "",
    encryptedPaymentId: paymentId
      ? await encryptAttendeePII(paymentId, publicKeyJwk)
      : null,
    encryptedPricePaid: pricePaid !== null
      ? await encrypt(String(pricePaid))
      : null,
    encryptedCheckedIn: await encryptAttendeePII("false", publicKeyJwk),
  };
};

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (
  insertId: number | bigint | undefined,
  eventId: number,
  name: string,
  email: string,
  phone: string,
  created: string,
  paymentId: string | null,
  quantity: number,
  pricePaid: number | null,
  ticketToken: string,
): Attendee => ({
  id: Number(insertId),
  event_id: eventId,
  name,
  email,
  phone,
  created,
  payment_id: paymentId,
  quantity,
  price_paid: pricePaid !== null ? String(pricePaid) : null,
  checked_in: "false",
  ticket_token: ticketToken,
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

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendee: Attendee }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  /** Check if an event has available spots for the requested quantity */
  hasAvailableSpots: async (
    eventId: number,
    quantity = 1,
  ): Promise<boolean> => {
    const event = await getEventWithCount(eventId);
    if (!event) return false;
    return event.attendee_count + quantity <= event.max_attendees;
  },
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
    phone = "",
    pricePaid: number | null = null,
  ): Promise<CreateAttendeeResult> => {
    const enc = await encryptAttendeeFields(name, email, phone, paymentId, pricePaid);
    if (!enc) {
      return { success: false, reason: "encryption_error" };
    }

    const ticketToken = generateTicketToken();

    // Atomic check-and-insert: only inserts if capacity allows
    const insertResult = await getDb().execute({
      sql: `INSERT INTO attendees (event_id, name, email, phone, created, payment_id, quantity, price_paid, checked_in, ticket_token)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (
              SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ?
            ) + ? <= (
              SELECT max_attendees FROM events WHERE id = ?
            )`,
      args: [
        eventId,
        enc.encryptedName,
        enc.encryptedEmail,
        enc.encryptedPhone,
        enc.created,
        enc.encryptedPaymentId,
        qty,
        enc.encryptedPricePaid,
        enc.encryptedCheckedIn,
        ticketToken,
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
        phone,
        enc.created,
        paymentId,
        qty,
        pricePaid,
        ticketToken,
      ),
    };
  },
};

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const hasAvailableSpots = (
  eventId: number,
  quantity = 1,
): Promise<boolean> => attendeesApi.hasAvailableSpots(eventId, quantity);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const createAttendeeAtomic = (
  evtId: number,
  n: string,
  e: string,
  pId: string | null = null,
  q = 1,
  phone = "",
  price: number | null = null,
): Promise<CreateAttendeeResult> => attendeesApi.createAttendeeAtomic(evtId, n, e, pId, q, phone, price);

/**
 * Get attendees by ticket tokens (plaintext, no decryption needed for token lookup)
 * Returns attendees in the same order as the input tokens.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(Attendee | null)[]> => {
  const result = await getDb().execute({
    sql: `SELECT * FROM attendees WHERE ticket_token IN (${inPlaceholders(tokens)})`,
    args: tokens,
  });
  const rows = result.rows as unknown as Attendee[];
  const byToken = new Map(map((r: Attendee) => [r.ticket_token, r] as const)(rows));
  return map((t: string) => byToken.get(t) ?? null)(tokens);
};

/**
 * Update an attendee's checked_in status (encrypted)
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateCheckedIn = async (
  attendeeId: number,
  checkedIn: boolean,
): Promise<void> => {
  const publicKeyJwk = (await getPublicKey())!;

  const encryptedValue = await encryptAttendeePII(
    checkedIn ? "true" : "false",
    publicKeyJwk,
  );

  await getDb().execute({
    sql: "UPDATE attendees SET checked_in = ? WHERE id = ?",
    args: [encryptedValue, attendeeId],
  });
};
