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
import { nowIso } from "#lib/now.ts";
import { getPublicKey } from "#lib/db/settings.ts";
import { col, defineTable } from "#lib/db/table.ts";
import type { Attendee, ContactInfo } from "#lib/types.ts";

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
  const address = row.address
    ? await decryptAttendeePII(row.address, privateKey)
    : "";
  const special_instructions = row.special_instructions
    ? await decryptAttendeePII(row.special_instructions, privateKey)
    : "";
  const payment_id = row.payment_id
    ? await decryptAttendeePII(row.payment_id, privateKey)
    : null;
  const price_paid = row.price_paid ? await decrypt(row.price_paid) : null;
  const checked_in = row.checked_in
    ? await decryptAttendeePII(row.checked_in, privateKey)
    : "false";
  return { ...row, name, email, phone, address, special_instructions, payment_id, price_paid, checked_in };
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
  encryptedAddress: string;
  encryptedSpecialInstructions: string;
  encryptedPaymentId: string | null;
  encryptedPricePaid: string | null;
  encryptedCheckedIn: string;
};

/** Input for encrypting attendee fields */
type EncryptInput = ContactInfo & {
  paymentId: string | null;
  pricePaid: number | null;
};

/** Encrypt attendee fields, returning null if key not configured */
const encryptAttendeeFields = async (
  input: EncryptInput,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) return null;

  return {
    created: nowIso(),
    encryptedName: await encryptAttendeePII(input.name, publicKeyJwk),
    encryptedEmail: input.email
      ? await encryptAttendeePII(input.email, publicKeyJwk)
      : "",
    encryptedPhone: input.phone
      ? await encryptAttendeePII(input.phone, publicKeyJwk)
      : "",
    encryptedAddress: input.address
      ? await encryptAttendeePII(input.address, publicKeyJwk)
      : "",
    encryptedSpecialInstructions: input.special_instructions
      ? await encryptAttendeePII(input.special_instructions, publicKeyJwk)
      : "",
    encryptedPaymentId: input.paymentId
      ? await encryptAttendeePII(input.paymentId, publicKeyJwk)
      : null,
    encryptedPricePaid: input.pricePaid !== null
      ? await encrypt(String(input.pricePaid))
      : null,
    encryptedCheckedIn: await encryptAttendeePII("false", publicKeyJwk),
  };
};

/** Input for building an Attendee result from an insert */
type BuildAttendeeInput = ContactInfo & {
  insertId: number | bigint | undefined;
  eventId: number;
  created: string;
  paymentId: string | null;
  quantity: number;
  pricePaid: number | null;
  ticketToken: string;
  date: string | null;
};

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  event_id: input.eventId,
  name: input.name,
  email: input.email,
  phone: input.phone,
  address: input.address,
  special_instructions: input.special_instructions,
  created: input.created,
  payment_id: input.paymentId,
  quantity: input.quantity,
  price_paid: input.pricePaid !== null ? String(input.pricePaid) : null,
  checked_in: "false",
  ticket_token: input.ticketToken,
  date: input.date,
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

/** Input for creating an attendee atomically */
export type AttendeeInput = Pick<ContactInfo, "name" | "email"> & Partial<Pick<ContactInfo, "phone" | "address" | "special_instructions">> & {
  eventId: number;
  paymentId?: string | null;
  quantity?: number;
  pricePaid?: number | null;
  date?: string | null;
};

/** Item for batch availability check */
export type BatchAvailabilityItem = { eventId: number; quantity: number };

/** Get the total attendee quantity for a specific event + date */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
): Promise<number> => {
  const result = await getDb().execute({
    sql: "SELECT COALESCE(SUM(quantity), 0) as count FROM attendees WHERE event_id = ? AND date = ?",
    args: [eventId, date],
  });
  return (result.rows[0] as unknown as { count: number }).count;
};

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  /**
   * Check availability for multiple events in a single query.
   * Uses a JOIN with conditional date filtering: daily events check per-date
   * capacity while standard events check total capacity.
   */
  checkBatchAvailability: async (
    items: BatchAvailabilityItem[],
    date?: string | null,
  ): Promise<boolean> => {
    if (items.length === 0) return true;
    const eventIds = items.map((i) => i.eventId);
    const result = await getDb().execute({
      sql: `SELECT e.id, e.max_attendees,
              COALESCE(SUM(a.quantity), 0) as current_count
            FROM events e
            LEFT JOIN attendees a ON a.event_id = e.id
              AND (e.event_type != 'daily' OR a.date = ?)
            WHERE e.id IN (${inPlaceholders(eventIds)})
            GROUP BY e.id`,
      args: [date ?? null, ...eventIds],
    });
    const counts = new Map(
      (result.rows as unknown as Array<{ id: number; max_attendees: number; current_count: number }>)
        .map((r) => [r.id, r]),
    );
    return items.every((item) => {
      const row = counts.get(item.eventId);
      return row ? row.current_count + item.quantity <= row.max_attendees : false;
    });
  },
  /** Check if an event has available spots for the requested quantity */
  hasAvailableSpots: async (
    eventId: number,
    quantity = 1,
    date?: string | null,
  ): Promise<boolean> => {
    const event = await getEventWithCount(eventId);
    if (!event) return false;
    if (date) {
      const dateCount = await getDateAttendeeCount(eventId, date);
      return dateCount + quantity <= event.max_attendees;
    }
    return event.attendee_count + quantity <= event.max_attendees;
  },
  /**
   * Atomically create attendee with capacity check in single SQL statement.
   * Prevents race conditions by combining check and insert.
   */
  createAttendeeAtomic: async (
    input: AttendeeInput,
  ): Promise<CreateAttendeeResult> => {
    const { eventId, name, email, paymentId = null, quantity: qty = 1, phone = "", address = "", special_instructions = "", pricePaid = null, date = null } = input;
    const enc = await encryptAttendeeFields({ name, email, phone, address, special_instructions, paymentId, pricePaid });
    if (!enc) {
      return { success: false, reason: "encryption_error" };
    }

    const ticketToken = generateTicketToken();

    // For daily events with a date, check capacity per-date; otherwise check total
    const capacityFilter = date
      ? "SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ? AND date = ?"
      : "SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ?";
    const capacityArgs = date ? [eventId, date] : [eventId];

    // Atomic check-and-insert: only inserts if capacity allows
    const insertResult = await getDb().execute({
      sql: `INSERT INTO attendees (event_id, name, email, phone, address, special_instructions, created, payment_id, quantity, price_paid, checked_in, ticket_token, date)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (
              ${capacityFilter}
            ) + ? <= (
              SELECT max_attendees FROM events WHERE id = ?
            )`,
      args: [
        eventId,
        enc.encryptedName,
        enc.encryptedEmail,
        enc.encryptedPhone,
        enc.encryptedAddress,
        enc.encryptedSpecialInstructions,
        enc.created,
        enc.encryptedPaymentId,
        qty,
        enc.encryptedPricePaid,
        enc.encryptedCheckedIn,
        ticketToken,
        date,
        ...capacityArgs,
        qty,
        eventId,
      ],
    });

    if (insertResult.rowsAffected === 0) {
      return { success: false, reason: "capacity_exceeded" };
    }

    return {
      success: true,
      attendee: buildAttendeeResult({
        insertId: insertResult.lastInsertRowid,
        eventId,
        name,
        email,
        phone,
        address,
        special_instructions,
        created: enc.created,
        paymentId,
        quantity: qty,
        pricePaid,
        ticketToken,
        date,
      }),
    };
  },
};

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const hasAvailableSpots = (
  eventId: number,
  quantity = 1,
  date?: string | null,
): Promise<boolean> => attendeesApi.hasAvailableSpots(eventId, quantity, date);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const createAttendeeAtomic = (
  input: AttendeeInput,
): Promise<CreateAttendeeResult> => attendeesApi.createAttendeeAtomic(input);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const checkBatchAvailability = (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => attendeesApi.checkBatchAvailability(items, date);

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
 * Clear the payment_id for an attendee after a successful refund.
 * Prevents double-refund by removing the payment reference.
 */
export const clearPaymentId = async (attendeeId: number): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE attendees SET payment_id = NULL WHERE id = ?",
    args: [attendeeId],
  });
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
