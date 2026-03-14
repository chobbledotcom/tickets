/**
 * Seed data generation for populating the database with sample events and attendees.
 * Uses batch writes for efficient database operations.
 */

import { map, reduce } from "#fp";
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
  DEMO_PHONES,
  DEMO_SPECIAL_INSTRUCTIONS,
  randomChoice,
  randomName,
} from "#lib/demo.ts";
import { nowIso } from "#lib/now.ts";
import { generateUniqueSlug, type SlugWithIndex } from "#lib/slug.ts";

/** Max attendees per seeded event */
export const SEED_MAX_ATTENDEES = 1000;

/** Pick a random ticket quantity (1-4) */
const randomQuantity = (): number => 1 + Math.floor(Math.random() * 4);

/** Sample unit prices in minor units (e.g. pence/cents) for paid events */
const DEMO_UNIT_PRICES = [500, 1000, 1500, 2000, 2500, 3000, 5000];

/** Sum an array of numbers */
const sum = reduce((acc: number, n: number) => acc + n, 0);

/** Generate slugs that are unique within the batch */
const generateUniqueSlugs = async (count: number): Promise<SlugWithIndex[]> => {
  const usedSlugs = new Set<string>();
  const results: SlugWithIndex[] = [];
  for (let i = 0; i < count; i++) {
    const result = await generateUniqueSlug(hmacHash, (slug) =>
      Promise.resolve(usedSlugs.has(slug)),
    );
    usedSlugs.add(result.slug);
    results.push(result);
  }
  return results;
};

/** Prepare encrypted values for a single event */
const prepareEvent = async (
  index: number,
  maxAttendees: number,
  unitPrice: number,
  slug: string,
  slugIndex: string,
) => {
  const name = DEMO_EVENT_NAMES[index % DEMO_EVENT_NAMES.length]!;
  const description =
    DEMO_EVENT_DESCRIPTIONS[index % DEMO_EVENT_DESCRIPTIONS.length]!;
  const location = DEMO_EVENT_LOCATIONS[index % DEMO_EVENT_LOCATIONS.length]!;
  const created = nowIso();

  const [
    encName,
    encSlug,
    encDesc,
    encLoc,
    encDate,
    encThankYou,
    encWebhook,
    encClosesAt,
    encImageUrl,
  ] = await Promise.all([
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
      encName,
      encSlug,
      slugIndex,
      encDesc,
      encDate,
      encLoc,
      0,
      created,
      maxAttendees,
      encThankYou,
      unitPrice,
      4,
      encWebhook,
      1,
      "email",
      encClosesAt,
      "standard",
      JSON.stringify([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]),
      1,
      90,
      encImageUrl,
      0,
    ],
  };
};

/** Encrypt a single PII value, curried over the public key */
const piiEncryptor = (publicKeyJwk: string) => (value: string) =>
  encryptAttendeePII(value, publicKeyJwk);

/** Prepare encrypted values for a single attendee */
const prepareAttendee = async (
  eventId: number,
  publicKeyJwk: string,
  quantity: number,
  unitPrice: number,
) => {
  const encPII = piiEncryptor(publicKeyJwk);
  const ticketToken = generateTicketToken();
  const created = nowIso();
  const pricePaid = String(unitPrice * quantity);

  // Encrypt contact fields, ticket metadata, and compute token index in parallel
  const [
    encContact,
    encPaymentId,
    encPricePaid,
    encCheckedIn,
    encRefunded,
    encTicketToken,
    ticketTokenIndex,
  ] = await Promise.all([
    Promise.all([
      encPII(randomName()),
      encPII(randomChoice(DEMO_EMAILS)),
      encPII(randomChoice(DEMO_PHONES)),
      encPII(randomChoice(DEMO_ADDRESSES)),
      encPII(randomChoice(DEMO_SPECIAL_INSTRUCTIONS)),
    ]),
    unitPrice > 0 ? encPII(`pi_seed_${eventId}_${Date.now()}`) : encPII(""),
    encrypt(pricePaid),
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
      eventId,
      encName,
      encEmail,
      encPhone,
      encAddress,
      encSpecial,
      created,
      encPaymentId,
      quantity,
      encPricePaid,
      encCheckedIn,
      encRefunded,
      encTicketToken,
      ticketTokenIndex,
      null,
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
 * Assigns random ticket quantities (1-4) per attendee without overselling.
 */
export const createSeeds = async (
  eventCount: number,
  attendeesPerEvent: number,
): Promise<SeedResult> => {
  const publicKeyJwk = await getPublicKey();
  if (!publicKeyJwk) throw new Error("Public key not configured");

  // Build structured event data: quantities, capacity, price, and slug per event
  const slugs = await generateUniqueSlugs(eventCount);
  const eventData = Array.from({ length: eventCount }, (_, i) => {
    const quantities = Array.from({ length: attendeesPerEvent }, () =>
      randomQuantity(),
    );
    return {
      index: i,
      quantities,
      capacity: sum(quantities),
      unitPrice: i % 2 === 0 ? randomChoice(DEMO_UNIT_PRICES) : 0,
      slug: slugs[i]!,
    };
  });

  // Prepare and insert events in a single batch
  const eventStatements = await Promise.all(
    map((d: (typeof eventData)[number]) =>
      prepareEvent(
        d.index,
        d.capacity,
        d.unitPrice,
        d.slug.slug,
        d.slug.slugIndex,
      ),
    )(eventData),
  );
  await executeBatch(eventStatements);
  invalidateEventsCache();

  // Query the newly created event IDs (ordered by id DESC, limit to eventCount)
  const rows = await queryAll<{ id: number }>(
    "SELECT id FROM events ORDER BY id DESC LIMIT ?",
    [eventCount],
  );
  const eventIds = map((r: { id: number }) => r.id)(rows).reverse();

  // Prepare all attendee inserts in parallel, in chunks to avoid memory pressure
  const CHUNK_SIZE = 50;
  let totalAttendees = 0;

  for (const [e, eventId] of eventIds.entries()) {
    const { quantities, unitPrice } = eventData[e]!;

    for (let offset = 0; offset < attendeesPerEvent; offset += CHUNK_SIZE) {
      const batchSize = Math.min(CHUNK_SIZE, attendeesPerEvent - offset);
      const chunkQuantities = quantities.slice(offset, offset + batchSize);
      const attendeeStatements = await Promise.all(
        map((q: number) =>
          prepareAttendee(eventId, publicKeyJwk, q, unitPrice),
        )(chunkQuantities),
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
