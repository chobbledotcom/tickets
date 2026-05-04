/**
 * Events table operations
 */

import type { ResultSet } from "@libsql/client";
import { filter as fpFilter } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
} from "#shared/db/attendees.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import {
  executeBatch,
  getDb,
  inPlaceholders,
  queryAll,
  queryBatch,
  resultRows,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
  registerCache,
} from "#shared/db/common-schema.ts";
import { col, withCacheInvalidation } from "#shared/db/table.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import type {
  Attendee,
  Event,
  EventFields,
  EventType,
  EventWithCount,
} from "#shared/types.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";

/** Default bookable days (all days of the week) */
export const DEFAULT_BOOKABLE_DAYS: string[] = [...VALID_DAY_NAMES];

/** Event input fields for create/update (camelCase) */
export type EventInput = {
  name: string;
  description?: string;
  date?: string;
  location?: string;
  slug: string;
  slugIndex: string;
  groupId?: number;
  maxAttendees: number;
  thankYouUrl?: string;
  unitPrice?: number;
  maxQuantity?: number;
  webhookUrl?: string;
  active?: boolean;
  fields?: EventFields;
  closesAt?: string;
  eventType?: EventType;
  bookableDays?: string[];
  minimumDaysBefore?: number;
  maximumDaysAfter?: number;
  imageUrl?: string;
  attachmentUrl?: string;
  attachmentName?: string;
  nonTransferable?: boolean;
  canPayMore?: boolean;
  maxPrice: number;
  hidden?: boolean;
  purchaseOnly?: boolean;
  assignBuiltSite?: boolean;
  durationDays?: number;
};

/** Compute slug index from slug for blind index lookup */
export const computeSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

const TZ_SUFFIX_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Normalize a datetime to a UTC ISO timestamp.
 * Logs and treats missing timezone offsets as UTC for legacy data.
 */
const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX_REGEX.test(value)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} missing timezone offset (${value})`,
    });
    normalized = `${value}Z`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} invalid datetime (${value})`,
    });
    return "";
  }
  return date.toISOString();
};

/** Encrypt a datetime value for DB storage (normalized to UTC) */
const encryptDatetime = (v: string, label: string): Promise<string> =>
  encrypt(normalizeUtcDatetime(v, label));

/** Decrypt an encrypted datetime from DB storage (empty → empty, otherwise → ISO) */
const decryptDatetime = async (v: string): Promise<string> => {
  const str = await decrypt(v);
  if (str === "") return "";
  return normalizeUtcDatetime(str, "stored datetime");
};

/** Encrypt closes_at for DB storage (null/empty → encrypted empty) */
export const writeClosesAt = (v: string | null): Promise<string | null> =>
  encryptDatetime(v ?? "", "closes_at");

/** Decrypt closes_at from DB storage (encrypted empty → null) */
const readClosesAt = async (v: string | null): Promise<string | null> => {
  // DB column is NOT NULL (writeClosesAt always encrypts), so v is always a string
  const result = await decryptDatetime(v!);
  return result === "" ? null : result;
};

/** Encrypt event date for DB storage */
export const writeEventDate = (v: string): Promise<string> =>
  encryptDatetime(v, "date");

/**
 * Events table definition
 * slug is encrypted; slug_index is HMAC for lookups
 * Write methods (insert, update, deleteById) auto-invalidate the events cache.
 */
const rawEventsTable = defineIdTable<Event, EventInput>("events", {
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  ...encryptedNameSchema(encrypt, decrypt),
  active: col.boolean(true),
  assign_built_site: col.boolean(false),
  attachment_name: col.encryptedText(encrypt, decrypt),
  attachment_url: col.encryptedText(encrypt, decrypt),
  bookable_days: col.converted<string[]>({
    default: () => [...DEFAULT_BOOKABLE_DAYS],
    read: (v) => {
      const parsed: unknown = JSON.parse(v as string);
      return Array.isArray(parsed) ? parsed : [];
    },
    write: (v) => JSON.stringify(v),
  }),
  can_pay_more: col.boolean(false),
  closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
  created: col.withDefault(() => nowIso()),
  date: { default: () => "", read: decryptDatetime, write: writeEventDate },
  description: col.encryptedText(encrypt, decrypt),
  duration_days: col.withDefault(() => 1),
  event_type: col.withDefault<EventType>(() => "standard"),
  fields: col.withDefault<EventFields>(() => "email"),
  group_id: col.withDefault(() => 0),
  hidden: col.boolean(false),
  image_url: col.encryptedText(encrypt, decrypt),
  location: col.encryptedText(encrypt, decrypt),
  max_attendees: col.simple<number>(),
  max_price: col.withDefault(() => 0),
  max_quantity: col.withDefault(() => 1),
  maximum_days_after: col.withDefault(() => 90),
  minimum_days_before: col.withDefault(() => 1),
  non_transferable: col.boolean(false),
  purchase_only: col.boolean(false),
  thank_you_url: col.encryptedText(encrypt, decrypt),
  unit_price: col.withDefault(() => 0),
  webhook_url: col.encryptedText(encrypt, decrypt),
});

export const eventsTable = withCacheInvalidation(rawEventsTable, () =>
  invalidateEventsCache(),
);

/** Find a cached event by ID */
const findCachedEventById = async (
  id: number,
): Promise<EventWithCount | null> => {
  const events = await eventsCache.getAll();
  return events.find((e) => e.id === id) ?? null;
};

/**
 * Get a single event by ID (from cache)
 */
export const getEvent = (id: number): Promise<Event | null> =>
  findCachedEventById(id);

/**
 * Check if a slug is already in use (optionally excluding a specific event ID)
 * Uses slug_index for lookup (blind index)
 */
export const isSlugTaken = async (
  slug: string,
  excludeEventId?: number,
): Promise<boolean> => {
  const slugIndex = await computeSlugIndex(slug);
  const sql = excludeEventId
    ? "SELECT 1 WHERE EXISTS (SELECT 1 FROM events WHERE slug_index = ? AND id != ?) OR EXISTS (SELECT 1 FROM groups WHERE slug_index = ?)"
    : "SELECT 1 WHERE EXISTS (SELECT 1 FROM events WHERE slug_index = ?) OR EXISTS (SELECT 1 FROM groups WHERE slug_index = ?)";
  const args = excludeEventId
    ? [slugIndex, excludeEventId, slugIndex]
    : [slugIndex, slugIndex];
  const result = await getDb().execute({ args, sql });
  return result.rows.length > 0;
};

/**
 * Delete an event and all its attendees in a single database round-trip.
 * Uses write batch to cascade: processed_payments → attendees → event.
 * Reduces 3 sequential HTTP round-trips to 1.
 */
export const deleteEvent = async (eventId: number): Promise<void> => {
  await executeBatch([
    // Remove event links first
    { args: [eventId], sql: "DELETE FROM event_attendees WHERE event_id = ?" },
    // Delete orphaned attendees (no remaining event links) and their dependent data
    {
      args: [],
      sql: "DELETE FROM processed_payments WHERE attendee_id NOT IN (SELECT attendee_id FROM event_attendees)",
    },
    {
      args: [],
      sql: "DELETE FROM attendee_answers WHERE attendee_id NOT IN (SELECT attendee_id FROM event_attendees)",
    },
    {
      args: [],
      sql: "DELETE FROM attendees WHERE id NOT IN (SELECT attendee_id FROM event_attendees)",
    },
    { args: [eventId], sql: "DELETE FROM activity_log WHERE event_id = ?" },
    { args: [eventId], sql: "DELETE FROM events WHERE id = ?" },
  ]);
  invalidateEventsCache();
};

/** Decrypt event fields and attach an attendee count */
const decryptAndAttachCount = async (
  row: Event,
  attendeeCount: number,
): Promise<EventWithCount> => {
  const event = await eventsTable.fromDb(row);
  return { ...event, attendee_count: attendeeCount };
};

/** Extract event row from batch result, returning null if not found */
const extractEventRow = (result: ResultSet): Event | null =>
  resultRows<Event>(result)[0] ?? null;

/** Extract event from batch result, decrypt and attach count. Returns null if event not found. */
const withBatchEvent = async <T>(
  eventResult: ResultSet,
  getCount: () => number,
  build: (event: EventWithCount) => T,
): Promise<T | null> => {
  const eventRow = extractEventRow(eventResult);
  if (!eventRow) return null;
  return build(await decryptAndAttachCount(eventRow, getCount()));
};

/** Query events with attendee counts, optionally filtered by a WHERE clause */
const queryEventsWithCounts = async (
  whereClause = "",
): Promise<EventWithCount[]> => {
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN event_attendees ea ON e.id = ea.event_id
     ${whereClause}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );
  return Promise.all(
    rows.map((row) => decryptAndAttachCount(row, row.attendee_count)),
  );
};

const eventsCache = requestCache(() => queryEventsWithCounts());

registerCache(() => ({ entries: eventsCache.size(), name: "events" }));

/** Invalidate the events cache (for testing or after writes). */
export const invalidateEventsCache = (): void => {
  eventsCache.invalidate();
};

/**
 * Get all events with attendee counts (from cache)
 */
export const getAllEvents = (): Promise<EventWithCount[]> =>
  eventsCache.getAll();

/**
 * Get event with attendee count (from cache)
 */
export const getEventWithCount = (id: number): Promise<EventWithCount | null> =>
  findCachedEventById(id);

/**
 * Get event with attendee count by slug (from cache)
 */
export const getEventWithCountBySlug = async (
  slug: string,
): Promise<EventWithCount | null> => {
  const slugIndex = await computeSlugIndex(slug);
  const events = await eventsCache.getAll();
  return events.find((e) => e.slug_index === slugIndex) ?? null;
};

/** Result type for combined event + attendees query */
export type EventWithAttendees = {
  event: EventWithCount;
  attendeesRaw: Attendee[];
};

/**
 * Get event and all attendees in a single database round-trip.
 * Uses batch API to execute both queries together, reducing latency
 * for remote databases like Turso from 2 RTTs to 1.
 * Computes attendee_count from the attendees array.
 */
export const getEventWithAttendeesRaw = async (
  id: number,
): Promise<EventWithAttendees | null> => {
  const [eventResult, attendeesResult] = await queryBatch([
    { args: [id], sql: "SELECT * FROM events WHERE id = ?" },
    {
      args: [id],
      sql: `SELECT ${ATTENDEE_JOIN_SELECT}
            FROM attendees a
            JOIN event_attendees ea ON ea.attendee_id = a.id
            WHERE ea.event_id = ?
            ORDER BY a.created DESC`,
    },
  ]);

  const attendeesRaw = resultRows<Attendee>(attendeesResult!);
  return withBatchEvent(
    eventResult!,
    () => attendeesRaw.reduce((sum, a) => sum + a.quantity, 0),
    (event) => ({ attendeesRaw, event }),
  );
};

/** Get cached events filtered by event_type */
const getCachedEventsByType = async (
  type: EventType,
): Promise<EventWithCount[]> => {
  const events = await eventsCache.getAll();
  return fpFilter((e: EventWithCount) => e.event_type === type)(events);
};

/**
 * Get all daily events with attendee counts (from cache).
 */
export const getAllDailyEvents = (): Promise<EventWithCount[]> =>
  getCachedEventsByType("daily");

/**
 * Get all standard events with attendee counts (from cache).
 * Used by the calendar view to include one-time events on their scheduled date.
 */
export const getAllStandardEvents = (): Promise<EventWithCount[]> =>
  getCachedEventsByType("standard");

/**
 * Get distinct attendee dates for daily events.
 * Used for the calendar date picker (lightweight, no attendee data).
 */
export const getDailyEventAttendeeDates = async (): Promise<string[]> => {
  const rows = await queryAll<{ date: string }>(
    `SELECT DISTINCT SUBSTR(ea.start_at, 1, 10) as date FROM event_attendees ea
     INNER JOIN events e ON ea.event_id = e.id
     WHERE e.event_type = 'daily' AND ea.start_at IS NOT NULL
     ORDER BY date`,
  );
  return rows.map((r) => r.date);
};

/**
 * Get raw attendees for daily events on a specific date.
 * Bounded query: only returns attendees matching the given date.
 */
export const getDailyEventAttendeesByDate = (
  date: string,
): Promise<Attendee[]> => {
  const { startAt, endAt } = dateToRange(date);
  return queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN event_attendees ea ON ea.attendee_id = a.id
     JOIN events e ON ea.event_id = e.id
     WHERE e.event_type = 'daily' AND ea.start_at < ? AND ea.end_at > ?
     ORDER BY a.created DESC`,
    [endAt, startAt],
  );
};

/**
 * Get raw attendees for a set of event IDs.
 * Used by the calendar to load attendees for standard events whose
 * decrypted date matches the selected calendar date.
 */
export const getAttendeesByEventIds = (
  eventIds: number[],
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN event_attendees ea ON ea.attendee_id = a.id
     WHERE ea.event_id IN (${inPlaceholders(eventIds)})
     ORDER BY a.created DESC`,
    eventIds,
  );

/** Result type for event + single attendee query */
export type EventWithAttendeeRaw = {
  event: EventWithCount;
  attendeeRaw: Attendee | null;
};

/**
 * Get event and a single attendee in a single database round-trip.
 * Used for attendee management pages where we need both the event context
 * and the specific attendee data.
 */
export const getEventWithAttendeeRaw = async (
  eventId: number,
  attendeeId: number,
): Promise<EventWithAttendeeRaw | null> => {
  const [eventResult, attendeeResult, countResult] = await queryBatch([
    { args: [eventId], sql: "SELECT * FROM events WHERE id = ?" },
    {
      args: [attendeeId],
      sql: `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
            FROM attendees a
            LEFT JOIN event_attendees ea ON ea.attendee_id = a.id
            WHERE a.id = ?`,
    },
    {
      args: [eventId],
      sql: "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ?",
    },
  ]);

  return withBatchEvent(
    eventResult!,
    () => resultRows<{ count: number }>(countResult!)[0]!.count,
    (event) => ({
      attendeeRaw: resultRows<Attendee>(attendeeResult!)[0] ?? null,
      event,
    }),
  );
};

/**
 * Get multiple events by slugs (from cache).
 * Returns events in the same order as the input slugs.
 * Missing or inactive events are returned as null.
 */
export const getEventsBySlugsBatch = async (
  slugs: string[],
): Promise<(EventWithCount | null)[]> => {
  if (slugs.length === 0) return [];

  // Compute slug indices for all slugs
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));

  const events = await eventsCache.getAll();
  const eventBySlugIndex = new Map<string, EventWithCount>();
  for (const event of events) {
    eventBySlugIndex.set(event.slug_index, event);
  }

  // Return events in the same order as input slugs
  return slugIndices.map((index) => eventBySlugIndex.get(index) ?? null);
};
