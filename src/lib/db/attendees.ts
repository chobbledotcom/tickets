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
  insert,
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
    a: info.address,
    e: info.email,
    n: info.name,
    p: info.phone,
    pi: info.payment_id,
    s: info.special_instructions,
    t: info.ticket_token,
    v: PII_BLOB_VERSION,
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
    address: blob.a,
    email: blob.e,
    name: blob.n,
    payment_id: paidEvent ? blob.pi : "",
    phone: blob.p,
    special_instructions: blob.s,
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
    checked_in: Boolean(row.checked_in),
    // Convert to proper types — value may be integer (from SQL) or boolean (from buildAttendeeView)
    price_paid: String(row.price_paid),
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
 * ticket count and income (sum of price_paid) via a single aggregate.
 */
export const getActiveEventStats = async (
  events: EventWithCount[],
): Promise<ActiveEventStats> => {
  const active = filter((e: EventWithCount) => e.active)(events);
  if (active.length === 0) {
    return { attendees: 0, income: 0, tickets: 0 };
  }
  const activeIds = map((e: EventWithCount) => e.id)(active);
  const attendees = reduce(
    (sum: number, e: EventWithCount) => sum + e.attendee_count,
    0,
  )(active);

  const row = (await queryOne<{ tickets: number; income: number }>(
    `SELECT COUNT(*) AS tickets,
            COALESCE(SUM(ea.price_paid), 0) AS income
       FROM event_attendees ea
      WHERE ea.event_id IN (${inPlaceholders(activeIds)})`,
    activeIds,
  ))!;
  return {
    attendees,
    income: row.income,
    tickets: row.tickets,
  };
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
  address,
  email,
  name,
  phone,
  special_instructions,
});

/** Build an INSERT statement for the attendees table from encrypted fields. */
export const buildAttendeeInsert = (enc: EncryptedAttendeeData) =>
  insert("attendees", {
    created: enc.created,
    pii_blob: enc.encryptedPiiBlob,
    ticket_token_index: enc.ticketTokenIndex,
  });

/** Encrypt attendee fields into a PII blob, returning null if key not configured */
export const encryptAttendeeFields = async (
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
    encryptedPiiBlob,
    ticketToken,
    ticketTokenIndex,
  };
};

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  event_id: input.eventId,
  id: Number(input.insertId),
  ...contactFields(input),
  attachment_downloads: 0,
  checked_in: false,
  created: input.created,
  date: input.date,
  payment_id: input.paymentId,
  pii_blob: "",
  price_paid: String(input.pricePaid),
  quantity: input.quantity,
  refunded: false,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
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
      args: [attendeeId],
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
    },
    {
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    },
    {
      args: [attendeeId],
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
    },
    { args: [attendeeId], sql: "DELETE FROM attendees WHERE id = ?" },
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
    args: [attendeeId, eventId],
    sql: "DELETE FROM event_attendees WHERE attendee_id = ? AND event_id = ?",
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
  reason: "capacity_exceeded" as const,
  success: false as const,
};

/** Add N calendar days to a YYYY-MM-DD date string (UTC-based). */
const addDaysStr = (dateStr: string, days: number): string => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Convert nullable date to start_at/end_at (null-safe wrapper around dateToRange) */
const dateToStartEnd = (
  date: string | null,
  durationDays = 1,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { endAt: null, startAt: null };
  const range = dateToRange(date, durationDays);
  return { endAt: range.endAt, startAt: range.startAt };
};

/**
 * Convert a date string ("YYYY-MM-DD") to a start_at/end_at pair.
 * The range is inclusive of `durationDays` calendar days starting at `date` @ 00:00Z;
 * `end_at` is the first midnight after the window (matches the existing 1-day semantic).
 */
export const dateToRange = (
  date: string,
  durationDays = 1,
): { startAt: string; endAt: string } => {
  const ms = new Date(`${date}T00:00:00Z`).getTime();
  const endIso = new Date(ms + durationDays * 86_400_000).toISOString();
  return { endAt: endIso, startAt: `${date}T00:00:00Z` };
};

/**
 * Recompute `end_at` on all existing `event_attendees` rows for an event based
 * on a new `duration_days` value. Leaves rows with NULL `start_at` (non-daily
 * events) unchanged. Runs as a single UPDATE so callers can batch it alongside
 * the corresponding event update.
 */
export const recomputeEventBookingRanges = async (
  eventId: number,
  durationDays: number,
): Promise<void> => {
  const duration = Math.max(1, Math.floor(durationDays));
  await getDb().execute({
    // datetime(start_at, '+N days') keeps same time-of-day; start_at is always
    // "YYYY-MM-DDT00:00:00Z" so the result is "YYYY-MM-DD 00:00:00" (no millis,
    // no Z). We stitch the ISO suffix ".000Z" back on so stored end_at values
    // exactly match what fresh inserts produce via `new Date(...).toISOString()`
    // — prevents scuzzy mixed formats in raw-row dumps and locks lexical
    // comparisons to a single shape.
    args: [duration, eventId],
    sql: `UPDATE event_attendees
           SET end_at = REPLACE(datetime(start_at, '+' || ? || ' days'), ' ', 'T') || '.000Z'
           WHERE event_id = ? AND start_at IS NOT NULL`,
  });
  invalidateEventsCache();
};

/**
 * Get the total attendee quantity for a specific event + date, optionally
 * excluding one attendee (used when an admin edits their own booking so the
 * row being updated doesn't fight itself in the capacity check).
 */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
  excludeAttendeeId?: number,
): Promise<number> => {
  const { startAt, endAt } = dateToRange(date);
  const sql = excludeAttendeeId
    ? "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND attendee_id != ? AND start_at < ? AND end_at > ?"
    : "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND start_at < ? AND end_at > ?";
  const args: InValue[] = excludeAttendeeId
    ? [eventId, excludeAttendeeId, endAt, startAt]
    : [eventId, endAt, startAt];
  const rows = await queryAll<{ count: number }>(sql, args);
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
 * Optional `excludeAttendeeId` skips rows belonging to that attendee — used by
 * self-excluding admin edits so a booking being moved doesn't fight itself.
 */
const getGroupAttendeeCount = async (
  groupId: number,
  date: string | null,
  excludeAttendeeId?: number,
): Promise<number> => {
  const range = date ? dateToRange(date) : null;
  const excludeClause = excludeAttendeeId ? " AND ea.attendee_id != ?" : "";
  const args: InValue[] = excludeAttendeeId
    ? [
        groupId,
        excludeAttendeeId,
        date,
        range?.endAt ?? null,
        range?.startAt ?? null,
      ]
    : [groupId, date, range?.endAt ?? null, range?.startAt ?? null];
  const rows = await queryAll<{ count: number }>(
    `SELECT COALESCE(SUM(ea.quantity), 0) as count
     FROM event_attendees ea
     JOIN events e ON e.id = ea.event_id
     WHERE e.group_id = ?${excludeClause}
       AND (? IS NULL OR e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
    args,
  );
  return rows[0]!.count;
};

/**
 * Accurate per-day availability check for a single-event booking, shared by
 * `hasAvailableSpots` (customer JSON API), `addEventLink`, and `updateEventLink`.
 *
 * Walks every day in `[date, date + durationDays)` and checks:
 *   - event's own max_attendees against existing per-day load
 *   - group's max_attendees (if any) against existing per-day group load
 *
 * Correct by construction — no overlap-sum false-rejection. The atomic SQL
 * insert/update still runs its own WHERE-guarded check as a race-free safety
 * net; this preflight ensures we don't fail rows that actually have room.
 */
/** Enumerate every day in [date, date + durationDays) for per-day checks,
 * or a single [null] for non-daily / date-less bookings. */
const capacityCheckDays = (
  isDaily: boolean,
  date: string | null | undefined,
  durationDays: number,
): (string | null)[] => {
  if (!isDaily || !date) return [null];
  const duration = Math.max(1, Math.floor(durationDays));
  return Array.from({ length: duration }, (_, i) => addDaysStr(date, i));
};

/** Existing event-level load for one day (null day = total). Self-excluding
 * so admin edits to their own booking don't fight themselves. */
const loadForDay = async (
  eventId: number,
  day: string | null,
  excludeAttendeeId: number | undefined,
  attendeeCount: number,
): Promise<number> => {
  if (day) return getDateAttendeeCount(eventId, day, excludeAttendeeId);
  if (!excludeAttendeeId) return attendeeCount;
  const row = await queryOne<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND attendee_id != ?",
    [eventId, excludeAttendeeId],
  );
  // SELECT COALESCE(SUM(...), 0) always returns exactly one row, so row is
  // never undefined here.
  return row!.count;
};

const checkEventCapForDays = async (
  eventId: number,
  quantity: number,
  days: (string | null)[],
  excludeAttendeeId: number | undefined,
  event: { max_attendees: number; attendee_count: number },
): Promise<boolean> => {
  for (const day of days) {
    const load = await loadForDay(
      eventId,
      day,
      excludeAttendeeId,
      event.attendee_count,
    );
    if (load + quantity > event.max_attendees) return false;
  }
  return true;
};

const checkGroupCapForDays = async (
  groupId: number,
  quantity: number,
  days: (string | null)[],
  excludeAttendeeId: number | undefined,
): Promise<boolean> => {
  const groupLimit = await getGroupMaxAttendees(groupId);
  if (groupLimit <= 0) return true;
  for (const day of days) {
    const groupCount = await getGroupAttendeeCount(
      groupId,
      day,
      excludeAttendeeId,
    );
    if (groupCount + quantity > groupLimit) return false;
  }
  return true;
};

const checkEventAvailability = async (
  eventId: number,
  quantity: number,
  date: string | null | undefined,
  excludeAttendeeId?: number,
  durationDays = 1,
): Promise<boolean> => {
  const event = await getEventWithCount(eventId);
  if (!event) return false;

  const days = capacityCheckDays(
    event.event_type === "daily",
    date,
    durationDays,
  );

  const eventOk = await checkEventCapForDays(
    eventId,
    quantity,
    days,
    excludeAttendeeId,
    event,
  );
  if (!eventOk) return false;

  if (event.group_id <= 0) return true;
  return checkGroupCapForDays(
    event.group_id,
    quantity,
    days,
    excludeAttendeeId,
  );
};

/**
 * Build a single-day capacity clause (event-cap + optional group-cap).
 * `dayRange` is null for non-daily bookings (date-less total check).
 */
const buildDayCapacitySql = (
  eventId: number,
  qty: number,
  dayRange: { startAt: string; endAt: string } | null,
  excludeAttendeeId?: number,
): { sql: string; args: InValue[] } => {
  const excludeClause = excludeAttendeeId ? " AND ea2.attendee_id != ?" : "";
  const capacityFilter = dayRange
    ? `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause} AND ea2.start_at < ? AND ea2.end_at > ?`
    : `SELECT COALESCE(SUM(ea2.quantity), 0) FROM event_attendees ea2 WHERE ea2.event_id = ?${excludeClause}`;
  const capacityArgs: InValue[] = dayRange
    ? excludeAttendeeId
      ? [eventId, excludeAttendeeId, dayRange.endAt, dayRange.startAt]
      : [eventId, dayRange.endAt, dayRange.startAt]
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
  const dayDate = dayRange?.startAt.slice(0, 10) ?? null;
  const groupCapacityArgs: InValue[] = excludeAttendeeId
    ? [
        excludeAttendeeId,
        dayDate,
        dayRange?.endAt ?? null,
        dayRange?.startAt ?? null,
        qty,
        eventId,
      ]
    : [
        dayDate,
        dayRange?.endAt ?? null,
        dayRange?.startAt ?? null,
        qty,
        eventId,
      ];

  return {
    args: [...capacityArgs, qty, eventId, ...groupCapacityArgs],
    sql: `(${capacityFilter}) + ? <= (SELECT max_attendees FROM events WHERE id = ?)${groupCapacityCheck}`,
  };
};

/**
 * Build the WHERE clause for capacity checking on event_attendees.
 *
 * Multi-day daily bookings emit one clause per day, AND'd together, so the
 * SQL safety-net matches the per-day accuracy of the JS preflight. A single
 * overlap-sum clause is strictly conservative — it's safe in the sense that
 * it never under-rejects, but it false-rejects admin edits whose range
 * contains existing non-overlapping bookings. Per-day expansion eliminates
 * that UX hazard; range length is bounded (≤90 via form validation) so the
 * SQL stays cheap.
 *
 * @param excludeAttendeeId - If set, excludes this attendee's rows from the count (for updates)
 */
const buildCapacityCondition = (
  eventId: number,
  qty: number,
  date: string | null,
  excludeAttendeeId?: number,
  durationDays = 1,
): { sql: string; args: InValue[] } => {
  if (!date) {
    return buildDayCapacitySql(eventId, qty, null, excludeAttendeeId);
  }
  const duration = Math.max(1, Math.floor(durationDays));
  if (duration === 1) {
    return buildDayCapacitySql(
      eventId,
      qty,
      dateToRange(date, 1),
      excludeAttendeeId,
    );
  }
  const clauses: string[] = [];
  const args: InValue[] = [];
  for (let i = 0; i < duration; i++) {
    const day = addDaysStr(date, i);
    const daily = buildDayCapacitySql(
      eventId,
      qty,
      dateToRange(day, 1),
      excludeAttendeeId,
    );
    clauses.push(`(${daily.sql})`);
    args.push(...daily.args);
  }
  return { args, sql: clauses.join(" AND ") };
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
  const {
    eventId,
    quantity: qty = 1,
    pricePaid = 0,
    date = null,
    durationDays = 1,
  } = booking;
  const condition = buildCapacityCondition(
    eventId,
    qty,
    date,
    undefined,
    durationDays,
  );
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const args: InValue[] = [eventId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(startAt, endAt, qty, pricePaid, ...condition.args);

  return {
    args,
    sql: `INSERT INTO event_attendees (event_id, attendee_id, start_at, end_at, quantity, price_paid)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?
          WHERE ${condition.sql}`,
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
    // Reject negative quantities outright — treating them as "no demand"
    // would let a caller bypass capacity by offsetting positive rows with
    // negative ones. Form validation clamps to ≥1 upstream, but a defensive
    // check here is cheap insurance.
    if (items.some((i) => i.quantity < 0)) return false;
    const eventIds = items.map((i) => i.eventId);

    const eventRows = await queryAll<{
      id: number;
      max_attendees: number;
      group_id: number;
      event_type: string;
    }>(
      `SELECT id, max_attendees, group_id, event_type
         FROM events
         WHERE id IN (${inPlaceholders(eventIds)})`,
      eventIds,
    );
    const eventsById = new Map(eventRows.map((r) => [r.id, r]));

    const daysOfRange = (startDate: string, durationDays: number): string[] => {
      const days: string[] = [];
      for (let i = 0; i < durationDays; i++) {
        days.push(addDaysStr(startDate, i));
      }
      return days;
    };

    // Per-day demand by (eventId, day) → quantity requested
    const perDayDemand = new Map<number, Map<string, number>>();
    // Non-daily/total demand by eventId → quantity
    const totalDemand = new Map<number, number>();

    for (const item of items) {
      const ev = eventsById.get(item.eventId);
      if (!ev) return false;
      const duration = Math.max(1, item.durationDays ?? 1);
      if (ev.event_type === "daily" && date) {
        const dayMap =
          perDayDemand.get(item.eventId) ?? new Map<string, number>();
        for (const day of daysOfRange(date, duration)) {
          dayMap.set(day, (dayMap.get(day) ?? 0) + item.quantity);
        }
        perDayDemand.set(item.eventId, dayMap);
      } else {
        totalDemand.set(
          item.eventId,
          (totalDemand.get(item.eventId) ?? 0) + item.quantity,
        );
      }
    }

    const perDayChecks: Promise<boolean>[] = [];
    for (const [eventId, dayMap] of perDayDemand) {
      const ev = eventsById.get(eventId)!;
      for (const [day, qty] of dayMap) {
        perDayChecks.push(
          (async () => {
            const existing = await getDateAttendeeCount(eventId, day);
            return existing + qty <= ev.max_attendees;
          })(),
        );
      }
    }
    const perDayResults = await Promise.all(perDayChecks);
    if (!perDayResults.every(Boolean)) return false;

    for (const [eventId, qty] of totalDemand) {
      const ev = eventsById.get(eventId)!;
      const row = await queryOne<{ count: number }>(
        "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ?",
        [eventId],
      );
      // SELECT COALESCE(SUM(...), 0) always returns one row; no nullish path.
      if (row!.count + qty > ev.max_attendees) return false;
    }

    // Group capacity: per-day across the union of requested daily days,
    // plus any non-daily demand against baseline group occupancy.
    const groupIds = new Set<number>();
    for (const ev of eventRows) {
      if (ev.group_id > 0) groupIds.add(ev.group_id);
    }
    for (const groupId of groupIds) {
      const groupLimit = await getGroupMaxAttendees(groupId);
      if (groupLimit <= 0) continue;

      const groupDayDemand = new Map<string, number>();
      let groupNonDailyDemand = 0;
      for (const item of items) {
        const ev = eventsById.get(item.eventId);
        if (!ev || ev.group_id !== groupId) continue;
        const duration = Math.max(1, item.durationDays ?? 1);
        if (ev.event_type === "daily" && date) {
          for (const day of daysOfRange(date, duration)) {
            groupDayDemand.set(
              day,
              (groupDayDemand.get(day) ?? 0) + item.quantity,
            );
          }
        } else {
          groupNonDailyDemand += item.quantity;
        }
      }

      for (const [day, qty] of groupDayDemand) {
        const existing = await getGroupAttendeeCount(groupId, day);
        if (existing + qty + groupNonDailyDemand > groupLimit) return false;
      }

      if (groupDayDemand.size === 0 && groupNonDailyDemand > 0) {
        const existing = await getGroupAttendeeCount(groupId, null);
        if (existing + groupNonDailyDemand > groupLimit) return false;
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
      return { reason: "capacity_exceeded", success: false };
    }
    // Reject negative quantities outright — the atomic insert would happily
    // store a negative row and skew future capacity sums.
    if (bookings.some((b) => (b.quantity ?? 1) < 0)) {
      return { reason: "capacity_exceeded", success: false };
    }
    // Reject duplicate (event_id, date) pairs in a single cart. The
    // event_attendees unique index is on (event_id, attendee_id, start_at),
    // so two rows with the same tuple would violate it — silently dropping
    // one insert and delivering a half-fulfilled booking. Force the caller
    // to merge quantities upstream rather than paper over the conflict.
    const seenKeys = new Set<string>();
    for (const b of bookings) {
      const key = `${b.eventId}|${b.date ?? ""}`;
      if (seenKeys.has(key)) {
        return { reason: "capacity_exceeded", success: false };
      }
      seenKeys.add(key);
    }

    const contactInfo = { address, email, name, phone, special_instructions };
    // Use first booking's pricePaid for encryption (PII blob is shared)
    const enc = await encryptAttendeeFields({
      ...contactInfo,
      paymentId,
      pricePaid: bookings[0]!.pricePaid ?? 0,
    });
    if (!enc) {
      return { reason: "encryption_error", success: false };
    }

    // Use a subquery to look up the attendee ID instead of last_insert_rowid().
    // last_insert_rowid() updates after each INSERT in a batch, so the 2nd+
    // booking would get the event_attendees row ID instead of the attendee ID.
    const attendeeIdExpr =
      "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";
    const bookingStatements = bookings.map((booking) => {
      const insert = buildCapacityCheckedInsert(booking, attendeeIdExpr);
      // Splice ticketTokenIndex after the first arg (eventId) to bind
      // the ? in the attendeeIdExpr subquery
      const combined: InValue[] = [
        insert.args[0]!,
        enc.ticketTokenIndex,
        ...insert.args.slice(1),
      ];
      return { args: combined, sql: insert.sql };
    });

    // Single ACID transaction: attendee first, then capacity-checked event links.
    // If all capacity checks fail, the attendee is cleaned up in the final step.
    const batchResults = await executeBatchWithResults([
      // Step 1: Create attendee record (unconditional)
      buildAttendeeInsert(enc),
      // Steps 2..N+1: One capacity-checked INSERT per booking
      ...bookingStatements,
      // Final step: Clean up attendee if no event links were created
      {
        args: [enc.ticketTokenIndex, enc.ticketTokenIndex],
        sql: `DELETE FROM attendees WHERE id = (
                SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
              ) AND NOT EXISTS (
                SELECT 1 FROM event_attendees WHERE attendee_id = (
                  SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
                )
              )`,
      },
    ]);

    // Check which bookings succeeded (steps 2..N+1 in batchResults, offset by 1)
    const successfulBookings: Attendee[] = [];
    for (let i = 0; i < bookings.length; i++) {
      if (batchResults[i + 1]!.rowsAffected > 0) {
        const booking = bookings[i]!;
        successfulBookings.push(
          buildAttendeeResult({
            eventId: booking.eventId,
            insertId: batchResults[0]!.lastInsertRowid,
            ...contactInfo,
            created: enc.created,
            date: booking.date ?? null,
            paymentId,
            pricePaid: booking.pricePaid ?? 0,
            quantity: booking.quantity ?? 1,
            ticketToken: enc.ticketToken,
            ticketTokenIndex: enc.ticketTokenIndex,
          }),
        );
      }
    }

    if (successfulBookings.length === 0) {
      return { reason: "capacity_exceeded", success: false };
    }

    invalidateEventsCache();
    return { attendees: successfulBookings, success: true };
  },
  /**
   * Check if an event has available spots for the requested quantity on the
   * given date. Duration-aware: for daily events with `durationDays > 1`,
   * every day in `[date, date + durationDays)` must have room (both event cap
   * and group cap). Without this expansion the customer-facing JSON API
   * (`/api/events/:slug/availability`) and `processBooking` would only inspect
   * the start day and hand back a misleading "available" for a range whose
   * middle or tail is full.
   */
  hasAvailableSpots: (
    eventId: number,
    quantity = 1,
    date?: string | null,
    durationDays = 1,
  ): Promise<boolean> =>
    checkEventAvailability(eventId, quantity, date, undefined, durationDays),
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
     FROM attendees WHERE ticket_token_index IN (${inPlaceholders(
       tokenIndexes,
     )})`,
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
      attachment_downloads: row.attachment_downloads,
      checked_in: row.checked_in,
      end_at: row.end_at,
      event_id: row.event_id,
      price_paid: row.price_paid,
      quantity: row.quantity,
      refunded: row.refunded,
      start_at: row.start_at,
    });
    bookingsByAttendee.set(row.attendee_id, list);
  }

  // Build AttendeeWithBookings map by token index
  const byTokenIndex = new Map<string, AttendeeWithBookings>();
  for (const row of attendeeRows) {
    byTokenIndex.set(row.ticket_token_index, {
      bookings: bookingsByAttendee.get(row.id) ?? [],
      created: row.created,
      id: row.id,
      pii_blob: row.pii_blob,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
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
      args: [value, attendeeId, eventId],
      sql: `UPDATE event_attendees SET ${field} = ? WHERE attendee_id = ? AND event_id = ?`,
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
    args: [attendeeId, eventId],
    sql: "UPDATE event_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ? AND event_id = ?",
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
    args: [encryptedPiiBlob, attendeeId],
    sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
  });
};

/**
 * Update a single event link's quantity and date with atomic capacity check.
 * Excludes this attendee's current row from the capacity calculation so
 * no-op edits (same quantity) don't self-fail.
 *
 * Runs a per-day preflight (accurate) before the atomic SQL UPDATE. Without
 * the preflight, the SQL overlap-sum guard would false-reject multi-day edits
 * whose target range contains existing non-overlapping bookings on separate
 * days — the atomic SQL still runs as a race-free safety net.
 */
export const updateEventLink = async (
  attendeeId: number,
  eventId: number,
  input: UpdateEventLinkInput,
): Promise<UpdateEventLinkResult> => {
  const { quantity: qty, date, durationDays = 1 } = input;

  const preflight = await checkEventAvailability(
    eventId,
    qty,
    date,
    attendeeId,
    durationDays,
  );
  if (!preflight) return CAPACITY_EXCEEDED;

  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const condition = buildCapacityCondition(
    eventId,
    qty,
    date,
    attendeeId,
    durationDays,
  );

  const result = await getDb().execute({
    args: [qty, startAt, endAt, attendeeId, eventId, ...condition.args],
    sql: `UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
          WHERE attendee_id = ? AND event_id = ? AND ${condition.sql}`,
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
 *
 * Runs a per-day preflight so multi-day events aren't false-rejected by the
 * SQL overlap-sum safety net. Self-exclusion isn't needed (new row).
 */
export const addEventLink = async (
  attendeeId: number,
  booking: EventBooking,
): Promise<UpdateEventLinkResult> => {
  const qty = booking.quantity ?? 1;

  const preflight = await checkEventAvailability(
    booking.eventId,
    qty,
    booking.date ?? null,
    undefined,
    booking.durationDays ?? 1,
  );
  if (!preflight) return CAPACITY_EXCEEDED;

  return checkCapacityResult(
    await getDb().execute(buildCapacityCheckedInsert(booking, "?", attendeeId)),
  );
};
