/**
 * Attendees table operations
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import type { InValue } from "@libsql/client";
import { filter, map, reduce } from "#fp";
import { computeTicketTokenIndex } from "#lib/crypto/hashing.ts";
import { decryptAttendeePII, encryptAttendeePII } from "#lib/crypto/keys.ts";
import { generateTicketToken } from "#lib/crypto/utils.ts";
import type {
  ActiveEventStats,
  AttendeeInput,
  BatchAvailabilityItem,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
  EncryptInput,
  UpdateAttendeeInput,
} from "#lib/db/attendee-types.ts";
import {
  executeBatch,
  executeBatchWithResults,
  getDb,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#lib/db/client.ts";
import { getEventWithCount, invalidateEventsCache } from "#lib/db/events.ts";
import { settings } from "#lib/db/settings.ts";
import { nowIso } from "#lib/now.ts";
import type {
  Attendee,
  ContactInfo,
  EventWithCount,
  PiiBlob,
} from "#lib/types.ts";

export type {
  ActiveEventStats,
  AttendeeInput,
  BatchAvailabilityItem,
  CreateAttendeeResult,
  UpdateAttendeeInput,
} from "#lib/db/attendee-types.ts";

import type { EventBooking } from "#lib/db/attendee-types.ts";

/** Current PII blob schema version */
export const PII_BLOB_VERSION = 1;

/** Build a PII blob JSON from contact fields */
const buildPiiBlob = (
  info: ContactInfo & { payment_id: string; ticket_token: string },
): string =>
  JSON.stringify({
    v: PII_BLOB_VERSION,
    n: info.name,
    e: info.email,
    p: info.phone,
    a: info.address,
    s: info.special_instructions,
    pi: info.payment_id,
    t: info.ticket_token,
  } satisfies PiiBlob);

/** Parse a PII blob JSON back into contact fields (defaults v to 1 for pre-versioned blobs) */
const parsePiiBlob = (json: string): PiiBlob => {
  const blob = JSON.parse(json) as PiiBlob;
  blob.v ??= PII_BLOB_VERSION;
  return blob;
};

/** Encrypt a PII blob JSON string with the public key */
const encryptPiiBlob = (
  blobJson: string,
  publicKeyJwk: string,
): Promise<string> => encryptAttendeePII(blobJson, publicKeyJwk);

/** Decrypt a PII blob and extract all contact fields */
const decryptPiiBlob = async (
  encrypted: string,
  privateKey: CryptoKey,
  paidEvent: boolean,
): Promise<{
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  payment_id: string;
  ticket_token: string;
}> => {
  const json = await decryptAttendeePII(encrypted, privateKey);
  const blob = parsePiiBlob(json);
  return {
    name: blob.n,
    email: blob.e,
    phone: blob.p,
    address: blob.a,
    special_instructions: blob.s,
    payment_id: paidEvent ? blob.pi : "",
    ticket_token: blob.t,
  };
};

/**
 * Decrypt attendee fields from the PII blob.
 * Requires migration to be complete (admin is gated behind migration).
 * When paidEvent is false, payment_id and refunded are skipped.
 */
const decryptAttendeeFields = async (
  row: Attendee,
  privateKey: CryptoKey,
  paidEvent = true,
): Promise<Attendee> => {
  const pii = await decryptPiiBlob(row.pii_blob, privateKey, paidEvent);
  return {
    ...row,
    ...pii,
    price_paid: String(row.price_paid_v2),
    checked_in: row.checked_in_v2 === 1,
    refunded: paidEvent ? row.refunded_v2 === 1 : false,
    attachment_downloads: row.attachment_downloads,
  };
};

/**
 * Attendee columns for JOIN queries — only the columns actually used at runtime.
 * Legacy per-field encrypted columns (name, email, phone, etc.) are omitted since
 * all PII is read from pii_blob and status from the _v2 columns.
 */
const ATTENDEE_COLS =
  "a.id, a.created, a.ticket_token_index, a.attachment_downloads, a.pii_blob";

/** Columns sourced from event_attendees (per-event data) */
const EA_COLS =
  "ea.event_id, SUBSTR(ea.start_at, 1, 10) as date, ea.quantity, ea.checked_in_v2, ea.refunded_v2, ea.price_paid_v2";

/** SELECT clause for attendee + event_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for backward compatibility with the Attendee type. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing event_attendees linkage still appear in results
 * (with event_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT = `${ATTENDEE_COLS}, COALESCE(ea.event_id, 0) as event_id, SUBSTR(ea.start_at, 1, 10) as date, COALESCE(ea.quantity, 0) as quantity, COALESCE(ea.checked_in_v2, 0) as checked_in_v2, COALESCE(ea.refunded_v2, 0) as refunded_v2, COALESCE(ea.price_paid_v2, 0) as price_paid_v2`;

/**
 * Get attendees for an event without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (eventId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE ea.event_id = ?
     ORDER BY a.created DESC`,
    [eventId],
  );

/**
 * Get the newest attendees across all events without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     ORDER BY a.created DESC LIMIT ?`,
    [limit],
  );

/**
 * Get aggregated statistics for active events.
 * Filters active events from the provided list, computes attendees
 * (sum of quantities) from cached EventWithCount data, and queries
 * ticket count (rows) and income (sum of price_paid_v2).
 */
export const getActiveEventStats = async (
  events: EventWithCount[],
): Promise<ActiveEventStats> => {
  const active = filter((e: EventWithCount) => e.active)(events);
  if (active.length === 0) {
    return { income: 0, tickets: 0, attendees: 0 };
  }
  const activeIds = map((e: EventWithCount) => e.id)(active);
  const attendees = reduce(
    (sum: number, e: EventWithCount) => sum + e.attendee_count,
    0,
  )(active);

  const rows = await queryAll<{ price_paid_v2: number }>(
    `SELECT ea.price_paid_v2 FROM event_attendees ea
     WHERE ea.event_id IN (${inPlaceholders(activeIds)})`,
    activeIds,
  );
  const income = reduce(
    (sum: number, r: { price_paid_v2: number }) => sum + r.price_paid_v2,
    0,
  )(rows);
  return { income, tickets: rows.length, attendees };
};

/**
 * Decrypt a list of raw attendees (all fields).
 * Used when attendees are fetched via batch query.
 */
export const decryptAttendees = (
  rows: Attendee[],
  privateKey: CryptoKey,
  paidEvent = true,
): Promise<Attendee[]> =>
  Promise.all(
    map((row: Attendee) => decryptAttendeeFields(row, privateKey, paidEvent))(
      rows,
    ),
  );

/**
 * Decrypt a single raw attendee, handling null input.
 * Used when attendee is fetched via batch query.
 */
export const decryptAttendeeOrNull = (
  row: Attendee | null,
  privateKey: CryptoKey,
): Promise<Attendee | null> =>
  row ? decryptAttendeeFields(row, privateKey) : Promise.resolve(null);

/** Extract ContactInfo fields from an object */
const contactFields = ({
  name,
  email,
  phone,
  address,
  special_instructions,
}: ContactInfo): ContactInfo => ({
  name,
  email,
  phone,
  address,
  special_instructions,
});

/** Encrypt attendee fields into a PII blob, returning null if key not configured */
const encryptAttendeeFields = async (
  input: EncryptInput,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = settings.publicKey;
  if (!publicKeyJwk) return null;

  const ticketToken = generateTicketToken();
  const piiJson = buildPiiBlob({
    ...contactFields(input),
    payment_id: input.paymentId,
    ticket_token: ticketToken,
  });

  const [ticketTokenIndex, encryptedPiiBlob] = await Promise.all([
    computeTicketTokenIndex(ticketToken),
    encryptPiiBlob(piiJson, publicKeyJwk),
  ]);

  return {
    created: nowIso(),
    ticketToken,
    ticketTokenIndex,
    encryptedPiiBlob,
  };
};

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  event_id: input.eventId,
  ...contactFields(input),
  created: input.created,
  payment_id: input.paymentId,
  quantity: input.quantity,
  price_paid: String(input.pricePaid),
  checked_in: false,
  refunded: false,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
  date: input.date,
  attachment_downloads: 0,
  pii_blob: "",
  checked_in_v2: 0,
  refunded_v2: 0,
  price_paid_v2: input.pricePaid,
});

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, event_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [id],
  );
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
  return row ? decryptAttendeeFields(row, privateKey) : null;
};

/**
 * Delete an attendee and its processed payments in a single database round-trip.
 * Uses write batch to cascade: processed_payments → attendee.
 * Reduces 2 sequential HTTP round-trips to 1.
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await executeBatch([
    {
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
      args: [attendeeId],
    },
    {
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
      args: [attendeeId],
    },
    { sql: "DELETE FROM attendees WHERE id = ?", args: [attendeeId] },
  ]);
  invalidateEventsCache();
};

/** Convert a date string ("YYYY-MM-DD") to start_at/end_at pair for full-day range */
export const dateToRange = (
  date: string,
): { startAt: string; endAt: string } => {
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const nextDay = new Date(ms + 86_400_000).toISOString();
  return { startAt: `${date}T00:00:00Z`, endAt: nextDay };
};

/** Get the total attendee quantity for a specific event + date */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
): Promise<number> => {
  const { startAt, endAt } = dateToRange(date);
  const rows = await queryAll<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND start_at < ? AND end_at > ?",
    [eventId, endAt, startAt],
  );
  return rows[0]!.count;
};

/** Get a group's max_attendees limit (0 = no limit) */
const getGroupMaxAttendees = async (groupId: number): Promise<number> => {
  const row = await queryOne<{ max_attendees: number }>(
    "SELECT max_attendees FROM groups WHERE id = ?",
    [groupId],
  );
  return row?.max_attendees ?? 0;
};

/**
 * Count total attendees across all events in a group.
 * Date-aware: standard events always count, daily events only count matching date.
 */
const getGroupAttendeeCount = async (
  groupId: number,
  date: string | null,
): Promise<number> => {
  const range = date ? dateToRange(date) : null;
  const rows = await queryAll<{ count: number }>(
    `SELECT COALESCE(SUM(ea.quantity), 0) as count
     FROM event_attendees ea
     JOIN events e ON e.id = ea.event_id
     WHERE e.group_id = ?
       AND (? IS NULL OR e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
    [groupId, date, range?.endAt ?? null, range?.startAt ?? null],
  );
  return rows[0]!.count;
};

/**
 * Build a capacity-checked INSERT INTO event_attendees for a single booking.
 * Uses last_insert_rowid() to reference the attendee created in step 1 of the batch.
 */
const buildCapacityCheckedInsert = (
  booking: EventBooking,
): { sql: string; args: InValue[] } => {
  const { eventId, quantity: qty = 1, pricePaid = 0, date = null } = booking;
  const range = date ? dateToRange(date) : null;
  const startAt = range?.startAt ?? null;
  const endAt = range?.endAt ?? null;

  const capacityFilter = date
    ? "SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ? AND ea2.start_at < ? AND ea2.end_at > ?"
    : "SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?";
  const capacityArgs: InValue[] = date ? [eventId, endAt, startAt] : [eventId];

  const groupCapacityCheck = `
          AND (
            SELECT CASE
              WHEN ev.group_id = 0 THEN 1
              WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
              WHEN (
                SELECT COALESCE(SUM(ea3.quantity), 0)
                FROM event_attendees ea3
                JOIN events e2 ON e2.id = ea3.event_id
                WHERE e2.group_id = ev.group_id
                  AND (? IS NULL OR e2.event_type != 'daily' OR (ea3.start_at < ? AND ea3.end_at > ?))
              ) + ? <= g.max_attendees THEN 1
              ELSE 0
            END
            FROM events ev
            LEFT JOIN groups g ON g.id = ev.group_id
            WHERE ev.id = ?
          ) = 1`;
  const groupCapacityArgs: InValue[] = [date, endAt, startAt, qty, eventId];

  return {
    sql: `INSERT INTO event_attendees (event_id, attendee_id, start_at, end_at, quantity, price_paid_v2)
          SELECT ?, last_insert_rowid(), ?, ?, ?, ?
          WHERE (
            ${capacityFilter}
          ) + ? <= (
            SELECT max_attendees FROM events WHERE id = ?
          )${groupCapacityCheck}`,
    args: [
      eventId,
      startAt,
      endAt,
      qty,
      pricePaid,
      ...capacityArgs,
      qty,
      eventId,
      ...groupCapacityArgs,
    ],
  };
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
    const range = date ? dateToRange(date) : null;
    const rows = await queryAll<{
      id: number;
      max_attendees: number;
      current_count: number;
      group_id: number;
    }>(
      `SELECT e.id, e.max_attendees,
              COALESCE(SUM(ea.quantity), 0) as current_count,
              e.group_id
            FROM events e
            LEFT JOIN event_attendees ea ON ea.event_id = e.id
              AND (e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))
            WHERE e.id IN (${inPlaceholders(eventIds)})
            GROUP BY e.id`,
      [range?.endAt ?? null, range?.startAt ?? null, ...eventIds],
    );
    const counts = new Map(rows.map((r) => [r.id, r]));
    // Per-event capacity check
    const eventOk = items.every((item) => {
      const row = counts.get(item.eventId);
      return row
        ? row.current_count + item.quantity <= row.max_attendees
        : false;
    });
    if (!eventOk) return false;

    // Group capacity check: collect unique group IDs with limits
    const groupIds = new Set<number>();
    for (const row of rows) {
      if (row.group_id > 0) groupIds.add(row.group_id);
    }
    for (const groupId of groupIds) {
      const groupLimit = await getGroupMaxAttendees(groupId);
      if (groupLimit <= 0) continue;
      const groupCount = await getGroupAttendeeCount(groupId, date ?? null);
      // Sum requested quantities for events in this group
      const requestedInGroup = items.reduce((sum, item) => {
        const row = counts.get(item.eventId);
        return row && row.group_id === groupId ? sum + item.quantity : sum;
      }, 0);
      if (groupCount + requestedInGroup > groupLimit) return false;
    }
    return true;
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
      if (dateCount + quantity > event.max_attendees) return false;
    } else {
      if (event.attendee_count + quantity > event.max_attendees) return false;
    }
    // Check group capacity if event belongs to a group with a limit
    if (event.group_id > 0) {
      const groupLimit = await getGroupMaxAttendees(event.group_id);
      if (groupLimit > 0) {
        const groupCount = await getGroupAttendeeCount(
          event.group_id,
          date ?? null,
        );
        if (groupCount + quantity > groupLimit) return false;
      }
    }
    return true;
  },
  /**
   * Atomically create an attendee linked to one or more events.
   * Single ACID batch transaction:
   *   1. INSERT attendee (unconditional)
   *   2..N+1. For each booking: INSERT event_attendees with capacity check
   *   N+2. Clean up attendee if ALL capacity checks failed
   * Returns one Attendee per successful booking.
   */
  createAttendeeAtomic: async (
    input: AttendeeInput,
  ): Promise<CreateAttendeeResult> => {
    const {
      name,
      email,
      paymentId = "",
      phone = "",
      address = "",
      special_instructions = "",
      bookings,
    } = input;
    if (bookings.length === 0) {
      return { success: false, reason: "capacity_exceeded" };
    }

    const contactInfo = { name, email, phone, address, special_instructions };
    // Use first booking's pricePaid for encryption (PII blob is shared)
    const enc = await encryptAttendeeFields({
      ...contactInfo,
      paymentId,
      pricePaid: bookings[0]!.pricePaid ?? 0,
    });
    if (!enc) {
      return { success: false, reason: "encryption_error" };
    }

    // Build capacity-checked INSERT for each booking
    const bookingStatements = bookings.map((booking) => {
      const { sql, args } = buildCapacityCheckedInsert(booking);
      return { sql, args };
    });

    // Single ACID transaction: attendee first, then capacity-checked event links.
    // If all capacity checks fail, the attendee is cleaned up in the final step.
    const batchResults = await executeBatchWithResults([
      // Step 1: Create attendee record (unconditional)
      {
        sql: `INSERT INTO attendees (name, email, created, ticket_token_index, pii_blob)
              VALUES ('', '', ?, ?, ?)`,
        args: [enc.created, enc.ticketTokenIndex, enc.encryptedPiiBlob],
      },
      // Steps 2..N+1: One capacity-checked INSERT per booking
      ...bookingStatements,
      // Final step: Clean up attendee if no event links were created
      {
        sql: `DELETE FROM attendees WHERE id = (
                SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
              ) AND NOT EXISTS (
                SELECT 1 FROM event_attendees WHERE attendee_id = (
                  SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
                )
              )`,
        args: [enc.ticketTokenIndex, enc.ticketTokenIndex],
      },
    ]);

    // Check which bookings succeeded (steps 2..N+1 in batchResults, offset by 1)
    const successfulBookings: Attendee[] = [];
    for (let i = 0; i < bookings.length; i++) {
      if (batchResults[i + 1]!.rowsAffected > 0) {
        const booking = bookings[i]!;
        successfulBookings.push(
          buildAttendeeResult({
            insertId: batchResults[0]!.lastInsertRowid,
            eventId: booking.eventId,
            ...contactInfo,
            created: enc.created,
            paymentId,
            quantity: booking.quantity ?? 1,
            pricePaid: booking.pricePaid ?? 0,
            ticketToken: enc.ticketToken,
            ticketTokenIndex: enc.ticketTokenIndex,
            date: booking.date ?? null,
          }),
        );
      }
    }

    if (successfulBookings.length === 0) {
      return { success: false, reason: "capacity_exceeded" };
    }

    invalidateEventsCache();
    return { success: true, attendees: successfulBookings };
  },
};

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const hasAvailableSpots = (
  ...args: Parameters<typeof attendeesApi.hasAvailableSpots>
): Promise<boolean> => attendeesApi.hasAvailableSpots(...args);

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
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE a.ticket_token_index IN (${inPlaceholders(tokenIndexes)})`,
    tokenIndexes,
  );

  // Build a map from token index to attendee
  const byTokenIndex = new Map(
    map((r: Attendee) => [r.ticket_token_index, r] as const)(rows),
  );

  // Return attendees in the same order as input tokens
  return map((idx: string) => byTokenIndex.get(idx) ?? null)(tokenIndexes);
};

/** Update a per-event status field on event_attendees */
const updateEventAttendeeField =
  (field: string) =>
  async (attendeeId: number, eventId: number, value: number): Promise<void> => {
    await getDb().execute({
      sql: `UPDATE event_attendees SET ${field} = ? WHERE attendee_id = ? AND event_id = ?`,
      args: [value, attendeeId, eventId],
    });
  };

const setRefundedV2 = updateEventAttendeeField("refunded_v2");
const setCheckedInV2 = updateEventAttendeeField("checked_in_v2");

/**
 * Mark an attendee as refunded for a specific event.
 * Keeps payment_id intact so payment details can still be viewed.
 */
export const markRefunded = (
  attendeeId: number,
  eventId: number,
): Promise<void> => setRefundedV2(attendeeId, eventId, 1);

/**
 * Update an attendee's checked_in status for a specific event.
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateCheckedIn = (
  attendeeId: number,
  eventId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedInV2(attendeeId, eventId, checkedIn ? 1 : 0);

/**
 * Increment the attachment download counter for an attendee.
 * Uses atomic SQL increment to avoid race conditions.
 */
export const incrementAttachmentDownloads = async (
  attendeeId: number,
): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE attendees SET attachment_downloads = attachment_downloads + 1 WHERE id = ?",
    args: [attendeeId],
  });
};

/**
 * Update an attendee's information (encrypted PII blob)
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateAttendee = async (
  attendeeId: number,
  input: UpdateAttendeeInput,
): Promise<void> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      ...input,
      payment_id: input.payment_id,
      ticket_token: input.ticket_token,
    }),
    settings.publicKey,
  );

  await executeBatch([
    {
      sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
      args: [encryptedPiiBlob, attendeeId],
    },
    {
      sql: "UPDATE event_attendees SET event_id = ?, quantity = ? WHERE attendee_id = ?",
      args: [input.event_id, input.quantity, attendeeId],
    },
  ]);
  invalidateEventsCache();
};
