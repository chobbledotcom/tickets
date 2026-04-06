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
  AttendeeWithBookings,
  BatchAvailabilityItem,
  CreateAttendeeResult,
  EventAttendeeRow,
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#lib/db/attendee-types.ts";

import type {
  AttendeeWithBookings,
  EventAttendeeRow,
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#lib/db/attendee-types.ts";

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
    // Convert to proper types — value may be integer (from SQL) or boolean (from buildAttendeeView)
    price_paid: String(row.price_paid),
    checked_in: Boolean(row.checked_in),
    refunded: paidEvent ? Boolean(row.refunded) : false,
  };
};

/**
 * Attendee columns for JOIN queries — only the columns actually used at runtime.
 * All PII is read from the encrypted pii_blob; per-event status lives on event_attendees.
 */
const ATTENDEE_COLS = "a.id, a.created, a.ticket_token_index, a.pii_blob";

/** Columns sourced from event_attendees (per-event data) */
const EA_COLS =
  "ea.event_id, SUBSTR(ea.start_at, 1, 10) as date, ea.quantity, ea.checked_in, ea.refunded, ea.price_paid, ea.attachment_downloads";

/** SELECT clause for attendee + event_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for backward compatibility with the Attendee type. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing event_attendees linkage still appear in results
 * (with event_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT = `${ATTENDEE_COLS}, COALESCE(ea.event_id, 0) as event_id, SUBSTR(ea.start_at, 1, 10) as date, COALESCE(ea.quantity, 0) as quantity, COALESCE(ea.checked_in, 0) as checked_in, COALESCE(ea.refunded, 0) as refunded, COALESCE(ea.price_paid, 0) as price_paid, COALESCE(ea.attachment_downloads, 0) as attachment_downloads`;

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
 * ticket count (rows) and income (sum of price_paid).
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

  const rows = await queryAll<{ price_paid: number }>(
    `SELECT ea.price_paid FROM event_attendees ea
     WHERE ea.event_id IN (${inPlaceholders(activeIds)})`,
    activeIds,
  );
  const income = reduce(
    (sum: number, r: { price_paid: number }) => sum + r.price_paid,
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
/** Delete an attendee and all dependent data (payments, answers, event links) */
const purgeAttendee = (attendeeId: number): Promise<void> =>
  executeBatch([
    {
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
      args: [attendeeId],
    },
    {
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
      args: [attendeeId],
    },
    {
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
      args: [attendeeId],
    },
    { sql: "DELETE FROM attendees WHERE id = ?", args: [attendeeId] },
  ]);

/**
 * Delete an attendee and all its event links, payments, and answers.
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await purgeAttendee(attendeeId);
  invalidateEventsCache();
};

/**
 * Remove a single event link for an attendee.
 * If the attendee has no remaining event links, deletes the attendee entirely.
 * Returns whether the attendee was fully deleted.
 */
export const unlinkAttendeeFromEvent = async (
  attendeeId: number,
  eventId: number,
): Promise<{ attendeeDeleted: boolean }> => {
  await getDb().execute({
    sql: "DELETE FROM event_attendees WHERE attendee_id = ? AND event_id = ?",
    args: [attendeeId, eventId],
  });

  const remaining = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM event_attendees WHERE attendee_id = ?",
    [attendeeId],
  );

  if (remaining && remaining.count === 0) {
    await purgeAttendee(attendeeId);
    invalidateEventsCache();
    return { attendeeDeleted: true };
  }

  invalidateEventsCache();
  return { attendeeDeleted: false };
};

/** Shared failure result for capacity-exceeded */
const CAPACITY_EXCEEDED = {
  success: false as const,
  reason: "capacity_exceeded" as const,
};

/** Convert nullable date to start_at/end_at (null-safe wrapper around dateToRange) */
const dateToStartEnd = (
  date: string | null,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { startAt: null, endAt: null };
  const range = dateToRange(date);
  return { startAt: range.startAt, endAt: range.endAt };
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
 * Build the WHERE clause for capacity checking on event_attendees.
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 */
const buildCapacityCondition = (
  eventId: number,
  qty: number,
  date: string | null,
  excludeAttendeeId?: number,
): { sql: string; args: InValue[] } => {
  const range = date ? dateToRange(date) : null;
  const endAt = range?.endAt ?? null;
  const startAt = range?.startAt ?? null;

  const excludeClause = excludeAttendeeId ? " AND ea2.attendee_id != ?" : "";
  const capacityFilter = date
    ? `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause} AND ea2.start_at < ? AND ea2.end_at > ?`
    : `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause}`;
  const capacityArgs: InValue[] = date
    ? excludeAttendeeId
      ? [eventId, excludeAttendeeId, endAt, startAt]
      : [eventId, endAt, startAt]
    : excludeAttendeeId
      ? [eventId, excludeAttendeeId]
      : [eventId];

  const groupExclude = excludeAttendeeId
    ? "AND ea3.attendee_id != ?\n                  "
    : "";
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
                  ${groupExclude}AND (? IS NULL OR e2.event_type != 'daily' OR (ea3.start_at < ? AND ea3.end_at > ?))
              ) + ? <= g.max_attendees THEN 1
              ELSE 0
            END
            FROM events ev
            LEFT JOIN groups g ON g.id = ev.group_id
            WHERE ev.id = ?
          ) = 1`;
  const groupCapacityArgs: InValue[] = excludeAttendeeId
    ? [excludeAttendeeId, date, endAt, startAt, qty, eventId]
    : [date, endAt, startAt, qty, eventId];

  return {
    sql: `(${capacityFilter}) + ? <= (SELECT max_attendees FROM events WHERE id = ?)${groupCapacityCheck}`,
    args: [...capacityArgs, qty, eventId, ...groupCapacityArgs],
  };
};

/**
 * Build a capacity-checked INSERT INTO event_attendees for a single booking.
 * Uses last_insert_rowid() to reference the attendee created in step 1 of the batch.
 */
/**
 * Build a capacity-checked INSERT into event_attendees.
 * @param attendeeIdExpr - SQL expression for attendee_id (e.g. "last_insert_rowid()" or "?")
 * @param attendeeIdArg - Argument for "?" expr, omit for last_insert_rowid()
 */
const buildCapacityCheckedInsert = (
  booking: EventBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: number,
): { sql: string; args: InValue[] } => {
  const { eventId, quantity: qty = 1, pricePaid = 0, date = null } = booking;
  const condition = buildCapacityCondition(eventId, qty, date);
  const { startAt, endAt } = dateToStartEnd(date);
  const args: InValue[] = [eventId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(startAt, endAt, qty, pricePaid, ...condition.args);

  return {
    sql: `INSERT INTO event_attendees (event_id, attendee_id, start_at, end_at, quantity, price_paid)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?
          WHERE ${condition.sql}`,
    args,
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

    // Use a subquery to look up the attendee ID instead of last_insert_rowid().
    // last_insert_rowid() updates after each INSERT in a batch, so the 2nd+
    // booking would get the event_attendees row ID instead of the attendee ID.
    const attendeeIdExpr =
      "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";
    const bookingStatements = bookings.map((booking) => {
      const { sql, args } = buildCapacityCheckedInsert(booking, attendeeIdExpr);
      // Splice ticketTokenIndex after the first arg (eventId) to bind
      // the ? in the attendeeIdExpr subquery
      const combined: InValue[] = [
        args[0]!,
        enc.ticketTokenIndex,
        ...args.slice(1),
      ];
      return { sql, args: combined };
    });

    // Single ACID transaction: attendee first, then capacity-checked event links.
    // If all capacity checks fail, the attendee is cleaned up in the final step.
    const batchResults = await executeBatchWithResults([
      // Step 1: Create attendee record (unconditional)
      {
        sql: `INSERT INTO attendees (created, ticket_token_index, pii_blob)
              VALUES (?, ?, ?)`,
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
/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all event_attendees for those attendees.
 * Returns results in the same order as input tokens (deduped). Bookings sorted
 * by start_at then event_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  // Dedupe tokens to prevent double processing
  const uniqueTokens = [...new Set(tokens)];
  const tokenIndexes = await Promise.all(
    map((t: string) => computeTicketTokenIndex(t))(uniqueTokens),
  );

  // Query 1: Get attendee base rows (no event join)
  type AttendeeBase = {
    id: number;
    created: string;
    ticket_token_index: string;
    pii_blob: string;
  };
  const attendeeRows = await queryAll<AttendeeBase>(
    `SELECT id, created, ticket_token_index, pii_blob
     FROM attendees WHERE ticket_token_index IN (${inPlaceholders(tokenIndexes)})`,
    tokenIndexes,
  );

  if (attendeeRows.length === 0) {
    return tokens.map(() => null);
  }

  // Query 2: Get all event links for these attendees
  const attendeeIds = attendeeRows.map((a) => a.id);
  const bookingRows = await queryAll<
    EventAttendeeRow & { attendee_id: number }
  >(
    `SELECT attendee_id, event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id IN (${inPlaceholders(attendeeIds)})
     ORDER BY start_at, event_id`,
    attendeeIds,
  );

  // Group bookings by attendee_id
  const bookingsByAttendee = new Map<number, EventAttendeeRow[]>();
  for (const row of bookingRows) {
    const list = bookingsByAttendee.get(row.attendee_id) ?? [];
    list.push({
      event_id: row.event_id,
      start_at: row.start_at,
      end_at: row.end_at,
      quantity: row.quantity,
      checked_in: row.checked_in,
      refunded: row.refunded,
      price_paid: row.price_paid,
      attachment_downloads: row.attachment_downloads,
    });
    bookingsByAttendee.set(row.attendee_id, list);
  }

  // Build AttendeeWithBookings map by token index
  const byTokenIndex = new Map<string, AttendeeWithBookings>();
  for (const row of attendeeRows) {
    byTokenIndex.set(row.ticket_token_index, {
      id: row.id,
      created: row.created,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
      pii_blob: row.pii_blob,
      bookings: bookingsByAttendee.get(row.id) ?? [],
    });
  }

  // Return in original token order (before dedup) using the unique index mapping
  const indexToResult = new Map(
    uniqueTokens.map((t, i) => [t, byTokenIndex.get(tokenIndexes[i]!) ?? null]),
  );
  return tokens.map((t) => indexToResult.get(t) ?? null);
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

const setRefunded = updateEventAttendeeField("refunded");
const setCheckedIn = updateEventAttendeeField("checked_in");

/**
 * Mark an attendee as refunded for a specific event.
 * Keeps payment_id intact so payment details can still be viewed.
 */
export const markRefunded = (
  attendeeId: number,
  eventId: number,
): Promise<void> => setRefunded(attendeeId, eventId, 1);

/**
 * Update an attendee's checked_in status for a specific event.
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateCheckedIn = (
  attendeeId: number,
  eventId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedIn(attendeeId, eventId, checkedIn ? 1 : 0);

/**
 * Increment the attachment download counter for an attendee.
 * Uses atomic SQL increment to avoid race conditions.
 */
export const incrementAttachmentDownloads = async (
  attendeeId: number,
  eventId: number,
): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE event_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ? AND event_id = ?",
    args: [attendeeId, eventId],
  });
};

/**
 * Update an attendee's PII (name, email, phone, etc.) — shared across all event links.
 * Caller must be authenticated admin (public key always exists after setup).
 */
export const updateAttendeePII = async (
  attendeeId: number,
  input: UpdateAttendeePIIInput,
): Promise<void> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      ...input,
      payment_id: input.payment_id,
      ticket_token: input.ticket_token,
    }),
    settings.publicKey,
  );
  await getDb().execute({
    sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
    args: [encryptedPiiBlob, attendeeId],
  });
};

/**
 * Update a single event link's quantity and date with atomic capacity check.
 * Excludes this attendee's current row from the capacity calculation so
 * no-op edits (same quantity) don't self-fail.
 */
/**
 * Update a single event link's quantity and date with atomic capacity check.
 * Excludes this attendee's current row from the capacity calculation.
 */
export const updateEventLink = async (
  attendeeId: number,
  eventId: number,
  input: UpdateEventLinkInput,
): Promise<UpdateEventLinkResult> => {
  const { quantity: qty, date } = input;
  const { startAt, endAt } = dateToStartEnd(date);
  const condition = buildCapacityCondition(eventId, qty, date, attendeeId);

  const result = await getDb().execute({
    sql: `UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
          WHERE attendee_id = ? AND event_id = ? AND ${condition.sql}`,
    args: [qty, startAt, endAt, attendeeId, eventId, ...condition.args],
  });

  return checkCapacityResult(result);
};

/** Check a capacity-guarded write result and invalidate cache on success */
const checkCapacityResult = (result: {
  rowsAffected: number;
}): UpdateEventLinkResult => {
  if (!result.rowsAffected) return CAPACITY_EXCEEDED;
  invalidateEventsCache();
  return { success: true };
};

/**
 * Add a new event link for an existing attendee with atomic capacity check.
 * Does NOT create a new attendee or touch PII — just inserts an event_attendees row.
 */
export const addEventLink = async (
  attendeeId: number,
  booking: EventBooking,
): Promise<UpdateEventLinkResult> =>
  checkCapacityResult(
    await getDb().execute(buildCapacityCheckedInsert(booking, "?", attendeeId)),
  );

/**
 * Merge a source attendee into a target attendee.
 * Moves all event_attendees rows from source to target (skipping conflicts).
 * Deletes the source attendee and all its associated data.
 * PII update (if the caller wants source PII) is handled separately via updateAttendeePII.
 */
export const mergeAttendees = async (
  targetId: number,
  sourceId: number,
): Promise<void> => {
  await executeBatch([
    {
      // Copy source bookings to target, skipping any that conflict.
      // SQLite treats NULL as distinct in unique indices, so INSERT OR IGNORE
      // won't catch NULL start_at conflicts — use WHERE NOT EXISTS instead.
      sql: `INSERT INTO event_attendees
              (event_id, attendee_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads)
            SELECT ea.event_id, ?, ea.start_at, ea.end_at, ea.quantity, ea.checked_in, ea.refunded, ea.price_paid, ea.attachment_downloads
            FROM event_attendees ea
            WHERE ea.attendee_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM event_attendees t
              WHERE t.attendee_id = ?
              AND t.event_id = ea.event_id
              AND (
                (ea.start_at IS NULL AND t.start_at IS NULL)
                OR ea.start_at = t.start_at
              )
            )`,
      args: [targetId, sourceId, targetId],
    },
    {
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
      args: [sourceId],
    },
    {
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
      args: [sourceId],
    },
    {
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
      args: [sourceId],
    },
    {
      sql: "DELETE FROM attendees WHERE id = ?",
      args: [sourceId],
    },
  ]);
  invalidateEventsCache();
};
