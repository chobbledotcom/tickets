/**
 * Seed data generation for populating the database with sample events and attendees.
 * Uses batch writes for efficient database operations.
 */

import { map } from "#fp";
import {
  computeTicketTokenIndex,
  encrypt,
  encryptAttendeePII,
  generateTicketToken,
  hmacHash,
} from "#lib/crypto.ts";
import { executeBatch, queryAll } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";
import { getPublicKey } from "#lib/db/settings.ts";
import {
  DEMO_ADDRESSES,
  DEMO_EMAILS,
  DEMO_EVENT_DESCRIPTIONS,
  DEMO_EVENT_LOCATIONS,
  DEMO_EVENT_NAMES,
  DEMO_NAMES,
  DEMO_PHONES,
  DEMO_SPECIAL_INSTRUCTIONS,
  randomChoice,
} from "#lib/demo.ts";
import { nowIso } from "#lib/now.ts";
import { generateSlug } from "#lib/slug.ts";

/** Max attendees per seeded event */
export const SEED_MAX_ATTENDEES = 50;

/** Prepare encrypted values for a single event */
const prepareEvent = async (index: number) => {
  const name = DEMO_EVENT_NAMES[index % DEMO_EVENT_NAMES.length]!;
  const description = DEMO_EVENT_DESCRIPTIONS[index % DEMO_EVENT_DESCRIPTIONS.length]!;
  const location = DEMO_EVENT_LOCATIONS[index % DEMO_EVENT_LOCATIONS.length]!;
  const slug = generateSlug();
  const slugIndex = await hmacHash(slug);
  const created = nowIso();

  const [encName, encSlug, encDesc, encLoc, encDate, encThankYou, encWebhook, encClosesAt, encImageUrl] =
    await Promise.all([
      encrypt(name),
      encrypt(slug),
      encrypt(description),
      encrypt(location),
      encrypt(""),
      encrypt(""),
      encrypt(""),
      encrypt(""),
      encrypt(""),
    ]);

  return {
    sql: `INSERT INTO events (name, slug, slug_index, description, date, location, group_id, created, max_attendees, thank_you_url, unit_price, max_quantity, webhook_url, active, fields, closes_at, event_type, bookable_days, minimum_days_before, maximum_days_after, image_url, non_transferable)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      encName, encSlug, slugIndex, encDesc, encDate, encLoc,
      0, created, SEED_MAX_ATTENDEES, encThankYou, null, 1,
      encWebhook, 1, "email", encClosesAt, "standard",
      JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
      1, 90, encImageUrl, 0,
    ],
  };
};

/** Encrypt a single PII value, curried over the public key */
const piiEncryptor = (publicKeyJwk: string) => (value: string) =>
  encryptAttendeePII(value, publicKeyJwk);

/** Prepare encrypted values for a single attendee */
const prepareAttendee = async (eventId: number, publicKeyJwk: string) => {
  const encPII = piiEncryptor(publicKeyJwk);
  const ticketToken = generateTicketToken();
  const created = nowIso();

  // Encrypt contact fields, ticket metadata, and compute token index in parallel
  const [encContact, encPaymentId, encPricePaid, encCheckedIn, encRefunded, encTicketToken, ticketTokenIndex] =
    await Promise.all([
      Promise.all([encPII(randomChoice(DEMO_NAMES)), encPII(randomChoice(DEMO_EMAILS)), encPII(randomChoice(DEMO_PHONES)), encPII(randomChoice(DEMO_ADDRESSES)), encPII(randomChoice(DEMO_SPECIAL_INSTRUCTIONS))]),
      encPII(""),
      encrypt("0"),
      encPII("false"),
      encPII("false"),
      encPII(ticketToken),
      computeTicketTokenIndex(ticketToken),
    ]);

  const [encName, encEmail, encPhone, encAddress, encSpecial] = encContact;
  return {
    sql: `INSERT INTO attendees (event_id, name, email, phone, address, special_instructions, created, payment_id, quantity, price_paid, checked_in, refunded, ticket_token, ticket_token_index, date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      eventId, encName, encEmail, encPhone, encAddress, encSpecial,
      created, encPaymentId, 1, encPricePaid, encCheckedIn, encRefunded,
      encTicketToken, ticketTokenIndex, null,
    ],
  };
};

/** Result of a seed operation */
export type SeedResult = {
  eventsCreated: number;
  attendeesCreated: number;
};

/**
 * Create seed events and attendees using efficient batch writes.
 * Encrypts all data before inserting, matching production behavior.
 */
export const createSeeds = async (
  eventCount: number,
  attendeesPerEvent: number,
): Promise<SeedResult> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) throw new Error("Public key not configured");

  // Prepare all event inserts in parallel
  const eventStatements = await Promise.all(
    map((i: number) => prepareEvent(i))(Array.from({ length: eventCount }, (_, i) => i)),
  );

  // Insert events in a single batch and get their IDs
  await executeBatch(eventStatements);
  invalidateEventsCache();

  // Query the newly created event IDs (ordered by id DESC, limit to eventCount)
  const rows = await queryAll<{ id: number }>(
    `SELECT id FROM events ORDER BY id DESC LIMIT ?`,
    [eventCount],
  );
  const eventIds = map((r: { id: number }) => r.id)(rows).reverse();

  // Prepare all attendee inserts in parallel, in chunks to avoid memory pressure
  const CHUNK_SIZE = 50;
  let totalAttendees = 0;

  for (const eventId of eventIds) {
    for (let offset = 0; offset < attendeesPerEvent; offset += CHUNK_SIZE) {
      const batchSize = Math.min(CHUNK_SIZE, attendeesPerEvent - offset);
      const attendeeStatements = await Promise.all(
        map((_: number) => prepareAttendee(eventId, publicKeyJwk))(
          Array.from({ length: batchSize }, (_, i) => i),
        ),
      );
      await executeBatch(attendeeStatements);
      totalAttendees += batchSize;
    }
  }

  invalidateEventsCache();

  return {
    eventsCreated: eventCount,
    attendeesCreated: totalAttendees,
  };
};
