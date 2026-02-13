/**
 * Events table operations
 */

import { decrypt, encrypt, hmacHash } from "#lib/crypto.ts";
import { executeByField, getDb, inPlaceholders, queryBatch, queryOne } from "#lib/db/client.ts";
import { col, defineTable } from "#lib/db/table.ts";
import { nowIso } from "#lib/now.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import type { Attendee, Event, EventFields, EventType, EventWithCount } from "#lib/types.ts";

/** Default bookable days (all days of the week) as a JSON array string */
export const DEFAULT_BOOKABLE_DAYS = JSON.stringify(VALID_DAY_NAMES);

/** Event input fields for create/update (camelCase) */
export type EventInput = {
  name: string;
  description?: string;
  date?: string;
  location?: string;
  slug: string;
  slugIndex: string;
  maxAttendees: number;
  thankYouUrl?: string | null;
  unitPrice?: number | null;
  maxQuantity?: number;
  webhookUrl?: string | null;
  active?: number;
  fields?: EventFields;
  closesAt?: string;
  eventType?: EventType;
  bookableDays?: string;
  minimumDaysBefore?: number;
  maximumDaysAfter?: number;
};

/** Compute slug index from slug for blind index lookup */
export const computeSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

/** Encrypt a datetime value for DB storage (already normalized to UTC by the route handler) */
const encryptDatetime = async (v: string): Promise<string> => {
  if (v === "") return await encrypt("");
  return await encrypt(v);
};

/** Decrypt an encrypted datetime from DB storage (empty → empty, otherwise → ISO) */
const decryptDatetime = async (v: string): Promise<string> => {
  const str = await decrypt(v);
  if (str === "") return "";
  return new Date(str).toISOString();
};

/** Encrypt closes_at for DB storage (null/empty → encrypted empty) */
export const writeClosesAt = (v: string | null): Promise<string | null> =>
  encryptDatetime((v as string) ?? "");

/** Decrypt closes_at from DB storage (encrypted empty → null) */
const readClosesAt = async (v: string | null): Promise<string | null> => {
  const result = await decryptDatetime(v as string);
  return result === "" ? null : result;
};

/** Encrypt event date for DB storage */
export const writeEventDate = (v: string): Promise<string> =>
  encryptDatetime(v);

/**
 * Events table definition
 * slug is encrypted; slug_index is HMAC for lookups
 */
export const eventsTable = defineTable<Event, EventInput>({
  name: "events",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    name: col.encrypted<string>(encrypt, decrypt),
    description: { default: () => "", write: encrypt, read: decrypt },
    date: { default: () => "", write: writeEventDate, read: decryptDatetime },
    location: { default: () => "", write: encrypt, read: decrypt },
    slug: col.encrypted<string>(encrypt, decrypt),
    slug_index: col.simple<string>(),
    created: col.withDefault(() => nowIso()),
    max_attendees: col.simple<number>(),
    thank_you_url: col.encryptedNullable<string>(encrypt, decrypt),
    unit_price: col.simple<number | null>(),
    max_quantity: col.withDefault(() => 1),
    webhook_url: col.encryptedNullable<string>(encrypt, decrypt),
    active: col.withDefault(() => 1),
    fields: col.withDefault<EventFields>(() => "email"),
    closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
    event_type: col.withDefault<EventType>(() => "standard"),
    bookable_days: col.withDefault(() => DEFAULT_BOOKABLE_DAYS),
    minimum_days_before: col.withDefault(() => 1),
    maximum_days_after: col.withDefault(() => 90),
  },
});


/**
 * Get a single event by ID
 */
export const getEvent = (id: number): Promise<Event | null> =>
  eventsTable.findById(id);

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
    ? "SELECT 1 FROM events WHERE slug_index = ? AND id != ?"
    : "SELECT 1 FROM events WHERE slug_index = ?";
  const args = excludeEventId ? [slugIndex, excludeEventId] : [slugIndex];
  const result = await getDb().execute({ sql, args });
  return result.rows.length > 0;
};

/**
 * Delete an event and all its attendees
 */
export const deleteEvent = async (eventId: number): Promise<void> => {
  // Delete all attendees for this event first (cascade)
  await executeByField("attendees", "event_id", eventId);
  // Delete the event
  await eventsTable.deleteById(eventId);
};

/** Decrypt event fields after raw query (for JOIN queries) */
const decryptEventWithCount = async (
  row: EventWithCount,
): Promise<EventWithCount> => {
  const event = await eventsTable.fromDb(row as unknown as Event);
  return { ...event, attendee_count: row.attendee_count };
};

/** Decrypt raw event row and add attendee count */
const decryptEventRow = async (
  row: Event,
  attendeeCount: number,
): Promise<EventWithCount> => {
  const event = await eventsTable.fromDb(row);
  return { ...event, attendee_count: attendeeCount };
};

/** Extract event row from batch result, returning null if not found */
const extractEventRow = (result: { rows: unknown[] } | undefined): Event | null =>
  (result?.rows[0] as unknown as Event) ?? null;

/** Query events with attendee counts, optionally filtered by a WHERE clause */
const queryEventsWithCounts = async (
  whereClause = "",
): Promise<EventWithCount[]> => {
  const result = await getDb().execute(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     ${whereClause}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );
  const rows = result.rows as unknown as EventWithCount[];
  return Promise.all(rows.map(decryptEventWithCount));
};

/**
 * Get all events with attendee counts (sum of quantities)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getAllEvents = (): Promise<EventWithCount[]> =>
  queryEventsWithCounts();

/**
 * Get event with attendee count (sum of quantities)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getEventWithCount = async (
  id: number,
): Promise<EventWithCount | null> => {
  const row = await queryOne<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.id = ?
     GROUP BY e.id`,
    [id],
  );
  return row ? decryptEventWithCount(row) : null;
};

/**
 * Get event with attendee count by slug (uses slug_index for lookup)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getEventWithCountBySlug = async (
  slug: string,
): Promise<EventWithCount | null> => {
  const slugIndex = await computeSlugIndex(slug);
  const row = await queryOne<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.slug_index = ?
     GROUP BY e.id`,
    [slugIndex],
  );
  return row ? decryptEventWithCount(row) : null;
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

  const eventRow = extractEventRow(eventResult);
  if (!eventRow) return null;

  const attendeesRaw = attendeesResult!.rows as unknown as Attendee[];
  const count = attendeesRaw.reduce((sum, a) => sum + a.quantity, 0);
  return { event: await decryptEventRow(eventRow, count), attendeesRaw };
};

/**
 * Get all daily events with attendee counts (no attendees loaded).
 */
export const getAllDailyEvents = (): Promise<EventWithCount[]> =>
  queryEventsWithCounts("WHERE e.event_type = 'daily'");

/**
 * Get distinct attendee dates for daily events.
 * Used for the calendar date picker (lightweight, no attendee data).
 */
export const getDailyEventAttendeeDates = async (): Promise<string[]> => {
  const result = await getDb().execute(
    `SELECT DISTINCT a.date FROM attendees a
     INNER JOIN events e ON a.event_id = e.id
     WHERE e.event_type = 'daily' AND a.date IS NOT NULL
     ORDER BY a.date`,
  );
  return (result.rows as unknown as { date: string }[]).map((r) => r.date);
};

/**
 * Get raw attendees for daily events on a specific date.
 * Bounded query: only returns attendees matching the given date.
 */
export const getDailyEventAttendeesByDate = async (
  date: string,
): Promise<Attendee[]> => {
  const result = await getDb().execute({
    sql: `SELECT a.* FROM attendees a
          INNER JOIN events e ON a.event_id = e.id
          WHERE e.event_type = 'daily' AND a.date = ?
          ORDER BY a.created DESC`,
    args: [date],
  });
  return result.rows as unknown as Attendee[];
};

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

  const eventRow = extractEventRow(eventResult);
  if (!eventRow) return null;

  const count = (countResult!.rows[0] as unknown as { count: number }).count;
  return {
    event: await decryptEventRow(eventRow, count),
    attendeeRaw: (attendeeResult?.rows[0] as unknown as Attendee) ?? null,
  };
};

/**
 * Get multiple events by slugs in a single database round-trip.
 * Returns events in the same order as the input slugs.
 * Missing or inactive events are returned as null.
 */
export const getEventsBySlugsBatch = async (
  slugs: string[],
): Promise<(EventWithCount | null)[]> => {
  if (slugs.length === 0) return [];

  // Compute slug indices for all slugs
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));

  // Build a single query with IN clause for all slug indices
  const result = await getDb().execute({
    sql: `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
          FROM events e
          LEFT JOIN attendees a ON e.id = a.event_id
          WHERE e.slug_index IN (${inPlaceholders(slugIndices)})
          GROUP BY e.id`,
    args: slugIndices,
  });

  const rows = result.rows as unknown as EventWithCount[];
  const decryptedEvents = await Promise.all(rows.map(decryptEventWithCount));

  // Create a map of slug_index -> event for ordering
  const eventBySlugIndex = new Map<string, EventWithCount>();
  for (const event of decryptedEvents) {
    eventBySlugIndex.set(event.slug_index, event);
  }

  // Return events in the same order as input slugs
  return slugIndices.map((index) => eventBySlugIndex.get(index) ?? null);
};
