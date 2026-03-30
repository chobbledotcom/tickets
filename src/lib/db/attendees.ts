/**
 * Attendees table operations
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

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
 * Get attendees for an event without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (eventId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    [eventId],
  );

/**
 * Get the newest attendees across all events without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  queryAll<Attendee>("SELECT * FROM attendees ORDER BY created DESC LIMIT ?", [
    limit,
  ]);

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
    `SELECT price_paid_v2 FROM attendees WHERE event_id IN (${inPlaceholders(activeIds)})`,
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
    { sql: "DELETE FROM attendees WHERE id = ?", args: [attendeeId] },
  ]);
  invalidateEventsCache();
};

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
  const rows = await queryAll<{ count: number }>(
    `SELECT COALESCE(SUM(a.quantity), 0) as count
     FROM attendees a
     JOIN events e ON e.id = a.event_id
     WHERE e.group_id = ?
       AND (? IS NULL OR e.event_type != 'daily' OR a.date = ?)`,
    [groupId, date, date],
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
      group_id: number;
    }>(
      `SELECT e.id, e.max_attendees,
              COALESCE(SUM(a.quantity), 0) as current_count,
              e.group_id
            FROM events e
            LEFT JOIN attendees a ON a.event_id = e.id
              AND (e.event_type != 'daily' OR a.date = ?)
            WHERE e.id IN (${inPlaceholders(eventIds)})
            GROUP BY e.id`,
      [date ?? null, ...eventIds],
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

    // Group capacity check via single CASE expression — one event+group lookup.
    // Skips when group_id=0 (no group) or max_attendees=0 (no limit).
    // Date-aware: standard events always count, daily events only count matching date.
    const groupCapacityCheck = `
            AND (
              SELECT CASE
                WHEN ev.group_id = 0 THEN 1
                WHEN COALESCE(g.max_attendees, 0) = 0 THEN 1
                WHEN (
                  SELECT COALESCE(SUM(a2.quantity), 0)
                  FROM attendees a2
                  JOIN events e2 ON e2.id = a2.event_id
                  WHERE e2.group_id = ev.group_id
                    AND (? IS NULL OR e2.event_type != 'daily' OR a2.date = ?)
                ) + ? <= g.max_attendees THEN 1
                ELSE 0
              END
              FROM events ev
              LEFT JOIN groups g ON g.id = ev.group_id
              WHERE ev.id = ?
            ) = 1`;
    const groupCapacityArgs = [
      date, // date IS NULL check
      date, // date match
      qty, // quantity to add
      eventId, // event lookup
    ];

    // Atomic check-and-insert: only inserts if capacity allows
    const insertResult = await getDb().execute({
      sql: `INSERT INTO attendees (event_id, name, email, created, quantity, ticket_token_index, date, pii_blob, checked_in_v2, refunded_v2, price_paid_v2)
            SELECT ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (
              ${capacityFilter}
            ) + ? <= (
              SELECT max_attendees FROM events WHERE id = ?
            )${groupCapacityCheck}`,
      args: [
        eventId,
        enc.created,
        qty,
        enc.ticketTokenIndex,
        date,
        enc.encryptedPiiBlob,
        0,
        0,
        pricePaid,
        ...capacityArgs,
        qty,
        eventId,
        ...groupCapacityArgs,
      ],
    });

    if (insertResult.rowsAffected === 0) {
      return { success: false, reason: "capacity_exceeded" };
    }

    invalidateEventsCache();
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

/** Update a v2 integer column on an attendee */
const updateV2Field =
  (field: string) =>
  async (attendeeId: number, value: number): Promise<void> => {
    await getDb().execute({
      sql: `UPDATE attendees SET ${field} = ? WHERE id = ?`,
      args: [value, attendeeId],
    });
  };

const setRefundedV2 = updateV2Field("refunded_v2");
const setCheckedInV2 = updateV2Field("checked_in_v2");

/**
 * Mark an attendee as refunded.
 * Keeps payment_id intact so payment details can still be viewed.
 */
export const markRefunded = (attendeeId: number): Promise<void> =>
  setRefundedV2(attendeeId, 1);

/**
 * Update an attendee's checked_in status
 * Caller must be authenticated admin (public key always exists after setup)
 */
export const updateCheckedIn = (
  attendeeId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedInV2(attendeeId, checkedIn ? 1 : 0);

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

  await getDb().execute({
    sql: "UPDATE attendees SET event_id = ?, quantity = ?, pii_blob = ? WHERE id = ?",
    args: [input.event_id, input.quantity, encryptedPiiBlob, attendeeId],
  });
  invalidateEventsCache();
};
