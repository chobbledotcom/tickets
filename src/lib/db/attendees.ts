/**
 * Attendees table operations
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import { map } from "#fp";
import {
  computeTicketTokenIndex,
  decrypt,
  decryptAttendeePII,
  encrypt,
  encryptAttendeePII,
  generateTicketToken,
} from "#lib/crypto.ts";
import { getDb, inPlaceholders, queryAll, queryOne } from "#lib/db/client.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { deleteProcessedPaymentsForAttendee } from "#lib/db/processed-payments.ts";
import { nowIso } from "#lib/now.ts";
import { getPublicKey } from "#lib/db/settings.ts";
import { col, defineTable } from "#lib/db/table.ts";
import { parseEventFields } from "#lib/event-fields.ts";
import type { Attendee, ContactField, ContactInfo } from "#lib/types.ts";

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

/** Decrypt a boolean-like field, returning "false" for empty/null values */
const decryptBoolField = (value: string, privateKey: CryptoKey): Promise<string> =>
  value ? decryptAttendeePII(value, privateKey) : Promise.resolve("false");

/** Conditionally decrypt a contact field, returning "" if not in the active set */
const decryptField = (
  value: string,
  privateKey: CryptoKey,
  field: ContactField,
  activeFields: ReadonlySet<ContactField> | null,
): Promise<string> =>
  !activeFields || activeFields.has(field) ? decryptAttendeePII(value, privateKey) : Promise.resolve("");

/**
 * Decrypt attendee fields using the private key.
 * When activeFields is null, all contact fields are decrypted.
 * When activeFields is provided, only those contact fields are decrypted
 * (others are set to ""), saving expensive hybrid RSA+AES operations.
 * When paidEvent is false, payment_id and refunded are skipped too.
 */
const decryptAttendeeFields = async (
  row: Attendee,
  privateKey: CryptoKey,
  activeFields: ReadonlySet<ContactField> | null,
  paidEvent = true,
): Promise<Attendee> => {
  const [
    name,
    email,
    phone,
    address,
    special_instructions,
    payment_id,
    price_paid,
    checked_in,
    refundedStr,
    ticket_token,
  ] = await Promise.all([
    decryptAttendeePII(row.name, privateKey),
    decryptField(row.email, privateKey, "email", activeFields),
    decryptField(row.phone, privateKey, "phone", activeFields),
    decryptField(row.address, privateKey, "address", activeFields),
    decryptField(row.special_instructions, privateKey, "special_instructions", activeFields),
    paidEvent ? decryptAttendeePII(row.payment_id, privateKey) : Promise.resolve(""),
    paidEvent ? decrypt(row.price_paid) : Promise.resolve("0"),
    decryptBoolField(row.checked_in, privateKey),
    // Raw DB value is an encrypted string; cast needed since Attendee type declares boolean
    paidEvent ? decryptBoolField(row.refunded as unknown as string, privateKey) : Promise.resolve("false"),
    decryptAttendeePII(row.ticket_token, privateKey),
  ]);
  return {
    ...row,
    name,
    email,
    phone,
    address,
    special_instructions,
    payment_id,
    price_paid,
    checked_in,
    refunded: refundedStr === "true",
    ticket_token,
  };
};

/**
 * Get attendees for an event without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (eventId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    [eventId],
  );

/**
 * Decrypt a list of raw attendees (all fields).
 * Used when attendees are fetched via batch query.
 */
export const decryptAttendees = (
  rows: Attendee[],
  privateKey: CryptoKey,
): Promise<Attendee[]> =>
  Promise.all(map((row: Attendee) => decryptAttendeeFields(row, privateKey, null))(rows));

/**
 * Decrypt a single raw attendee, handling null input.
 * Used when attendee is fetched via batch query.
 */
export const decryptAttendeeOrNull = (
  row: Attendee | null,
  privateKey: CryptoKey,
): Promise<Attendee | null> =>
  row ? decryptAttendeeFields(row, privateKey, null) : Promise.resolve(null);

/**
 * Decrypt attendees for table display, skipping contact fields
 * not configured on the event and payment fields for free events.
 * For a free event that only collects email, this skips up to 6
 * RSA decryptions per attendee (phone, address, special_instructions,
 * payment_id, refunded, plus 1 symmetric for price_paid).
 */
export const decryptAttendeesForTable = (
  rows: Attendee[],
  privateKey: CryptoKey,
  eventFields: string,
  paidEvent = true,
): Promise<Attendee[]> => {
  const activeFields = new Set(parseEventFields(eventFields));
  return Promise.all(
    map((row: Attendee) => decryptAttendeeFields(row, privateKey, activeFields, paidEvent))(rows),
  );
};

/** Encrypted attendee data for insertion */
type EncryptedAttendeeData = {
  created: string;
  encryptedName: string;
  encryptedEmail: string;
  encryptedPhone: string;
  encryptedAddress: string;
  encryptedSpecialInstructions: string;
  encryptedPaymentId: string;
  encryptedPricePaid: string;
  encryptedCheckedIn: string;
  encryptedRefunded: string;
  ticketToken: string;
  encryptedTicketToken: string;
  ticketTokenIndex: string;
};

/** Input for encrypting attendee fields - all ContactInfo fields are guaranteed to be strings */
type EncryptInput = ContactInfo & {
  paymentId: string;
  pricePaid: number;
};

/** Encrypt attendee fields, returning null if key not configured */
const encryptAttendeeFields = async (
  input: EncryptInput,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) return null;

  const ticketToken = generateTicketToken();

  return {
    created: nowIso(),
    encryptedName: await encryptAttendeePII(input.name, publicKeyJwk),
    encryptedEmail: await encryptAttendeePII(input.email, publicKeyJwk),
    encryptedPhone: await encryptAttendeePII(input.phone, publicKeyJwk),
    encryptedAddress: await encryptAttendeePII(input.address, publicKeyJwk),
    encryptedSpecialInstructions: await encryptAttendeePII(
      input.special_instructions,
      publicKeyJwk,
    ),
    encryptedPaymentId: await encryptAttendeePII(input.paymentId, publicKeyJwk),
    encryptedPricePaid: await encrypt(String(input.pricePaid)),
    encryptedCheckedIn: await encryptAttendeePII("false", publicKeyJwk),
    encryptedRefunded: await encryptAttendeePII("false", publicKeyJwk),
    ticketToken,
    encryptedTicketToken: await encryptAttendeePII(ticketToken, publicKeyJwk),
    ticketTokenIndex: await computeTicketTokenIndex(ticketToken),
  };
};

/** Input for building an Attendee result from an insert */
type BuildAttendeeInput = ContactInfo & {
  insertId: number | bigint | undefined;
  eventId: number;
  created: string;
  paymentId: string;
  quantity: number;
  pricePaid: number;
  ticketToken: string;
  ticketTokenIndex: string;
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
  price_paid: String(input.pricePaid),
  checked_in: "false",
  refunded: false,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
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
  return row ? decryptAttendeeFields(row, privateKey, null) : null;
};

/**
 * Delete an attendee (for cleanup on payment failure)
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await deleteProcessedPaymentsForAttendee(attendeeId);
  await attendeesTable.deleteById(attendeeId);
};

/** Result of atomic attendee creation */
export type CreateAttendeeResult =
  | { success: true; attendee: Attendee }
  | { success: false; reason: "capacity_exceeded" | "encryption_error" };

/** Input for creating an attendee atomically */
export type AttendeeInput = Pick<ContactInfo, "name" | "email"> &
  Partial<Pick<ContactInfo, "phone" | "address" | "special_instructions">> & {
    eventId: number;
    paymentId?: string;
    quantity?: number;
    pricePaid?: number;
    date?: string | null;
  };

/** Item for batch availability check */
export type BatchAvailabilityItem = { eventId: number; quantity: number };

/** Get the total attendee quantity for a specific event + date */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
): Promise<number> => {
  const rows = await queryAll<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM attendees WHERE event_id = ? AND date = ?",
    [eventId, date],
  );
  return rows[0]!.count;
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
    const rows = await queryAll<{
      id: number;
      max_attendees: number;
      current_count: number;
    }>(
      `SELECT e.id, e.max_attendees,
              COALESCE(SUM(a.quantity), 0) as current_count
            FROM events e
            LEFT JOIN attendees a ON a.event_id = e.id
              AND (e.event_type != 'daily' OR a.date = ?)
            WHERE e.id IN (${inPlaceholders(eventIds)})
            GROUP BY e.id`,
      [date ?? null, ...eventIds],
    );
    const counts = new Map(rows.map((r) => [r.id, r]));
    return items.every((item) => {
      const row = counts.get(item.eventId);
      return row
        ? row.current_count + item.quantity <= row.max_attendees
        : false;
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
    const {
      eventId,
      name,
      email,
      paymentId = "",
      quantity: qty = 1,
      phone = "",
      address = "",
      special_instructions = "",
      pricePaid = 0,
      date = null,
    } = input;
    // Ensure all ContactInfo fields are strings (convert undefined to empty string)
    const contactInfo = { name, email, phone, address, special_instructions };
    const enc = await encryptAttendeeFields({
      ...contactInfo,
      paymentId,
      pricePaid,
    });
    if (!enc) {
      return { success: false, reason: "encryption_error" };
    }

    // For daily events with a date, check capacity per-date; otherwise check total
    const capacityFilter = date
      ? "SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ? AND date = ?"
      : "SELECT COALESCE(SUM(quantity), 0) FROM attendees WHERE event_id = ?";
    const capacityArgs = date ? [eventId, date] : [eventId];

    // Atomic check-and-insert: only inserts if capacity allows
    const insertResult = await getDb().execute({
      sql: `INSERT INTO attendees (event_id, name, email, phone, address, special_instructions, created, payment_id, quantity, price_paid, checked_in, refunded, ticket_token, ticket_token_index, date)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        enc.encryptedRefunded,
        enc.encryptedTicketToken,
        enc.ticketTokenIndex,
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
        ticketToken: enc.ticketToken,
        ticketTokenIndex: enc.ticketTokenIndex,
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
 * Get attendees by ticket tokens (plaintext tokens, looked up via HMAC index)
 * Returns attendees in the same order as the input tokens.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(Attendee | null)[]> => {
  // Compute HMAC index for each token
  const tokenIndexes = await Promise.all(
    map((t: string) => computeTicketTokenIndex(t))(tokens),
  );

  const rows = await queryAll<Attendee>(
    `SELECT * FROM attendees WHERE ticket_token_index IN (${inPlaceholders(tokenIndexes)})`,
    tokenIndexes,
  );

  // Build a map from token index to attendee
  const byTokenIndex = new Map(
    map((r: Attendee) => [r.ticket_token_index, r] as const)(rows),
  );

  // Return attendees in the same order as input tokens
  return map((idx: string) => byTokenIndex.get(idx) ?? null)(tokenIndexes);
};

/**
 * Mark an attendee as refunded (set refunded to encrypted "true").
 * Keeps payment_id intact so payment details can still be viewed.
 */
export const markRefunded = async (attendeeId: number): Promise<void> => {
  const publicKeyJwk = (await getPublicKey())!;
  const encryptedTrue = await encryptAttendeePII("true", publicKeyJwk);
  await getDb().execute({
    sql: "UPDATE attendees SET refunded = ? WHERE id = ?",
    args: [encryptedTrue, attendeeId],
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

/** Input for updating an attendee */
export type UpdateAttendeeInput = {
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  event_id: number;
};

/**
 * Update an attendee's information (encrypted fields)
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateAttendee = async (
  attendeeId: number,
  input: UpdateAttendeeInput,
): Promise<void> => {
  const publicKeyJwk = (await getPublicKey())!;

  const encryptedName = await encryptAttendeePII(input.name, publicKeyJwk);
  const encryptedEmail = await encryptAttendeePII(input.email, publicKeyJwk);
  const encryptedPhone = await encryptAttendeePII(input.phone, publicKeyJwk);
  const encryptedAddress = await encryptAttendeePII(
    input.address,
    publicKeyJwk,
  );
  const encryptedSpecialInstructions = await encryptAttendeePII(
    input.special_instructions,
    publicKeyJwk,
  );

  await getDb().execute({
    sql: "UPDATE attendees SET name = ?, email = ?, phone = ?, address = ?, special_instructions = ?, event_id = ? WHERE id = ?",
    args: [
      encryptedName,
      encryptedEmail,
      encryptedPhone,
      encryptedAddress,
      encryptedSpecialInstructions,
      input.event_id,
      attendeeId,
    ],
  });
};
