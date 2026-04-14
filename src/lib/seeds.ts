/**
 * Seed data generation for populating the database with sample events and attendees.
 * Uses batch writes for efficient database operations.
 */

import { map, reduce } from "#fp";
import { encrypt } from "#lib/crypto/encryption.ts";
import { hmacHash } from "#lib/crypto/hashing.ts";
import { encryptAttendeeFields } from "#lib/db/attendees.ts";
import { executeBatch, insert, queryAll, rawSql } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";
import { settings } from "#lib/db/settings.ts";
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
import { generateUniqueSlug, type SlugWithIndex } from "#lib/slug.ts";

/** Max attendees per seeded event */
export const SEED_MAX_ATTENDEES = 100_000;

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

  const encryptBatch = <const T extends readonly string[]>(...values: T) =>
    Promise.all(map(encrypt)(values as unknown as string[])) as Promise<{
      [K in keyof T]: string;
    }>;
  const [encName, encSlug, encDesc, encLoc] = await encryptBatch(
    name,
    slug,
    description,
    location,
  );
  const [
    encDate,
    encThankYou,
    encWebhook,
    encClosesAt,
    encImageUrl,
    encAttachmentUrl,
    encAttachmentName,
  ] = await encryptBatch("", "", "", "", "", "", "");

  return insert("events", {
    name: encName,
    slug: encSlug,
    slug_index: slugIndex,
    description: encDesc,
    date: encDate,
    location: encLoc,
    group_id: 0,
    created,
    max_attendees: maxAttendees,
    thank_you_url: encThankYou,
    unit_price: unitPrice,
    max_quantity: 4,
    webhook_url: encWebhook,
    active: 1,
    fields: "email",
    closes_at: encClosesAt,
    event_type: "standard",
    bookable_days: JSON.stringify([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]),
    minimum_days_before: 1,
    maximum_days_after: 90,
    image_url: encImageUrl,
    attachment_url: encAttachmentUrl,
    attachment_name: encAttachmentName,
    non_transferable: 0,
  });
};

/** Prepare encrypted values for a single attendee */
const prepareAttendee = async (
  eventId: number,
  quantity: number,
  unitPrice: number,
) => {
  const pricePaid = unitPrice * quantity;
  const enc = await encryptAttendeeFields({
    address: randomChoice(DEMO_ADDRESSES),
    email: randomChoice(DEMO_EMAILS),
    name: randomChoice(DEMO_NAMES),
    paymentId: "",
    phone: randomChoice(DEMO_PHONES),
    pricePaid,
    special_instructions: randomChoice(DEMO_SPECIAL_INSTRUCTIONS),
  });
  if (!enc) throw new Error("Public key not configured");

  return [
    insert("attendees", {
      created: enc.created,
      pii_blob: enc.encryptedPiiBlob,
      ticket_token_index: enc.ticketTokenIndex,
    }),
    insert("event_attendees", {
      attendee_id: rawSql("last_insert_rowid()"),
      event_id: eventId,
      price_paid: pricePaid,
      quantity,
    }),
  ];
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
  if (!settings.publicKey) throw new Error("Public key not configured");

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
      const statementPairs = await Promise.all(
        map((q: number) => prepareAttendee(eventId, q, unitPrice))(
          chunkQuantities,
        ),
      );
      // Each pair is [attendee INSERT, event_attendees INSERT] — flatten in order
      // so each event_attendees INSERT follows its attendee (last_insert_rowid works)
      await executeBatch(statementPairs.flat());
      totalAttendees += batchSize;
    }
  }

  invalidateEventsCache();

  return {
    eventsCreated: eventCount,
    attendeesCreated: totalAttendees,
  };
};
