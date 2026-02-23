/**
 * Events table operations
 */

import type { ResultSet } from "@libsql/client";
import { filter as fpFilter, lazyRef } from "#fp";
import { decrypt, encrypt, hmacHash } from "#lib/crypto.ts";
import { executeByField, getDb, inPlaceholders, queryAll, queryBatch, resultRows } from "#lib/db/client.ts";
import { encryptedNameSchema, idAndEncryptedSlugSchema } from "#lib/db/common-schema.ts";
import { deleteProcessedPaymentsForEvent } from "#lib/db/processed-payments.ts";
import { defineIdTable } from "#lib/db/define-id-table.ts";
import { col } from "#lib/db/table.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { nowIso, nowMs } from "#lib/now.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import type { Attendee, Event, EventFields, EventType, EventWithCount } from "#lib/types.ts";

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
  thankYouUrl?: string | null;
  unitPrice?: number | null;
  maxQuantity?: number;
  webhookUrl?: string | null;
  active?: boolean;
  fields?: EventFields;
  closesAt?: string;
  eventType?: EventType;
  bookableDays?: string[];
  minimumDaysBefore?: number;
  maximumDaysAfter?: number;
  imageUrl?: string;
};

/** Compute slug index from slug for blind index lookup */
export const computeSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

const TZ_SUFFIX_REGEX = /(?:Z|[+\-]\d{2}:\d{2})$/i;

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
    logError({ code: ErrorCode.DATA_INVALID, detail: `${label} invalid datetime (${value})` });
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
 * In-memory events cache. Loads all events with attendee counts
 * in a single query and serves subsequent reads from memory until
 * the TTL expires or a write invalidates the cache.
 */
export const EVENTS_CACHE_TTL_MS = 60_000;

type EventsCacheState = {
  events: EventWithCount[] | null;
  time: number;
};

const [getEventsCacheState, setEventsCacheState] = lazyRef<EventsCacheState>(
  () => ({ events: null, time: 0 }),
);

const isEventsCacheValid = (): boolean => {
  const state = getEventsCacheState();
  return state.events !== null && nowMs() - state.time < EVENTS_CACHE_TTL_MS;
};

/** Invalidate the events cache (for testing or after writes). */
export const invalidateEventsCache = (): void => {
  setEventsCacheState(null);
};

/**
 * Events table definition
 * slug is encrypted; slug_index is HMAC for lookups
 * Write methods (insert, update, deleteById) auto-invalidate the events cache.
 */
const rawEventsTable = defineIdTable<Event, EventInput>("events", {
    ...idAndEncryptedSlugSchema(encrypt, decrypt),
    ...encryptedNameSchema(encrypt, decrypt),
    description: { default: () => "", write: encrypt, read: decrypt },
    date: { default: () => "", write: writeEventDate, read: decryptDatetime },
    location: { default: () => "", write: encrypt, read: decrypt },
    group_id: col.withDefault(() => 0),
    created: col.withDefault(() => nowIso()),
    max_attendees: col.simple<number>(),
    thank_you_url: col.encryptedNullable<string>(encrypt, decrypt),
    unit_price: col.simple<number | null>(),
    max_quantity: col.withDefault(() => 1),
    webhook_url: col.encryptedNullable<string>(encrypt, decrypt),
    active: col.converted<boolean>({
      default: () => true,
      write: (v) => v ? 1 : 0,
      read: (v) => v === 1,
    }),
    fields: col.withDefault<EventFields>(() => "email"),
    closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
    event_type: col.withDefault<EventType>(() => "standard"),
    bookable_days: col.converted<string[]>({
      default: () => [...DEFAULT_BOOKABLE_DAYS],
      write: (v) => JSON.stringify(v),
      read: (v) => {
        const parsed: unknown = JSON.parse(v as string);
        return Array.isArray(parsed) ? parsed : [];
      },
    }),
    minimum_days_before: col.withDefault(() => 1),
    maximum_days_after: col.withDefault(() => 90),
    image_url: { default: () => "", write: encrypt, read: decrypt },
  });

export const eventsTable: typeof rawEventsTable = {
  ...rawEventsTable,
  insert: async (input) => {
    const result = await rawEventsTable.insert(input);
    invalidateEventsCache();
    return result;
  },
  update: async (id, input) => {
    const result = await rawEventsTable.update(id, input);
    invalidateEventsCache();
    return result;
  },
  deleteById: async (id) => {
    await rawEventsTable.deleteById(id);
    invalidateEventsCache();
  },
};


/** Find a cached event by ID */
const findCachedEventById = async (id: number): Promise<EventWithCount | null> => {
  const events = await loadAllEventsCached();
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
  const args = excludeEventId ? [slugIndex, excludeEventId, slugIndex] : [slugIndex, slugIndex];
  const result = await getDb().execute({ sql, args });
  return result.rows.length > 0;
};

/**
 * Delete an event and all its attendees
 */
export const deleteEvent = async (eventId: number): Promise<void> => {
  // Delete all attendees for this event first (cascade)
  await deleteProcessedPaymentsForEvent(eventId);
  await executeByField("attendees", "event_id", eventId);
  // Delete the event
  await eventsTable.deleteById(eventId);
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

/** Query events with attendee counts, optionally filtered by a WHERE clause */
const queryEventsWithCounts = async (
  whereClause = "",
): Promise<EventWithCount[]> => {
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     ${whereClause}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );
  return Promise.all(rows.map((row) => decryptAndAttachCount(row, row.attendee_count)));
};

/**
 * Load all events with counts into the in-memory cache with a single query.
 */
const loadAllEventsCached = async (): Promise<EventWithCount[]> => {
  if (isEventsCacheValid()) return getEventsCacheState().events!;
  const events = await queryEventsWithCounts();
  setEventsCacheState({ events, time: nowMs() });
  return events;
};

/**
 * Get all events with attendee counts (from cache)
 */
export const getAllEvents = (): Promise<EventWithCount[]> =>
  loadAllEventsCached();

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
  const events = await loadAllEventsCached();
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
    { sql: "SELECT * FROM events WHERE id = ?", args: [id] },
    { sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC", args: [id] },
  ]);

  const eventRow = extractEventRow(eventResult!);
  if (!eventRow) return null;

  const attendeesRaw = resultRows<Attendee>(attendeesResult!);
  const count = attendeesRaw.reduce((sum, a) => sum + a.quantity, 0);
  return { event: await decryptAndAttachCount(eventRow, count), attendeesRaw };
};

/** Get cached events filtered by event_type */
const getCachedEventsByType = async (type: EventType): Promise<EventWithCount[]> => {
  const events = await loadAllEventsCached();
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
    `SELECT DISTINCT a.date FROM attendees a
     INNER JOIN events e ON a.event_id = e.id
     WHERE e.event_type = 'daily' AND a.date IS NOT NULL
     ORDER BY a.date`,
  );
  return rows.map((r) => r.date);
};

/**
 * Get raw attendees for daily events on a specific date.
 * Bounded query: only returns attendees matching the given date.
 */
export const getDailyEventAttendeesByDate = (
  date: string,
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT a.* FROM attendees a
          INNER JOIN events e ON a.event_id = e.id
          WHERE e.event_type = 'daily' AND a.date = ?
          ORDER BY a.created DESC`,
    [date],
  );

/**
 * Get raw attendees for a set of event IDs.
 * Used by the calendar to load attendees for standard events whose
 * decrypted date matches the selected calendar date.
 */
export const getAttendeesByEventIds = (
  eventIds: number[],
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT * FROM attendees WHERE event_id IN (${inPlaceholders(eventIds)}) ORDER BY created DESC`,
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
    { sql: "SELECT * FROM events WHERE id = ?", args: [eventId] },
    { sql: "SELECT * FROM attendees WHERE id = ?", args: [attendeeId] },
    { sql: "SELECT COALESCE(SUM(quantity), 0) as count FROM attendees WHERE event_id = ?", args: [eventId] },
  ]);

  const eventRow = extractEventRow(eventResult!);
  if (!eventRow) return null;

  const count = resultRows<{ count: number }>(countResult!)[0]!.count;
  return {
    event: await decryptAndAttachCount(eventRow, count),
    attendeeRaw: resultRows<Attendee>(attendeeResult!)[0] ?? null,
  };
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

  const events = await loadAllEventsCached();
  const eventBySlugIndex = new Map<string, EventWithCount>();
  for (const event of events) {
    eventBySlugIndex.set(event.slug_index, event);
  }

  // Return events in the same order as input slugs
  return slugIndices.map((index) => eventBySlugIndex.get(index) ?? null);
};
