/**
 * Seed data generation for populating the database with sample listings and attendees.
 * Uses batch writes for efficient database operations.
 */

import { map, sum } from "#fp";
import { encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  buildAttendeeInsert,
  encryptAttendeeFields,
} from "#shared/db/attendees.ts";
import { executeBatch, insert, queryAll, rawSql } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  DEMO_ADDRESSES,
  DEMO_EMAILS,
  DEMO_LISTING_DESCRIPTIONS,
  DEMO_LISTING_LOCATIONS,
  DEMO_LISTING_NAMES,
  DEMO_NAMES,
  DEMO_PHONES,
  DEMO_SPECIAL_INSTRUCTIONS,
  randomChoice,
} from "#shared/demo.ts";
import { nowIso } from "#shared/now.ts";
import { generateUniqueSlug, type SlugWithIndex } from "#shared/slug.ts";

/** Max attendees per seeded listing */
export const SEED_MAX_ATTENDEES = 100_000;

/** Pick a random ticket quantity (1-4) */
const randomQuantity = (): number => 1 + Math.floor(Math.random() * 4);

/** Sample unit prices in minor units (e.g. pence/cents) for paid listings */
const DEMO_UNIT_PRICES = [500, 1000, 1500, 2000, 2500, 3000, 5000];

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

/** Demo day-count prices derived from a base (1-day) price, so the seeded
 * customisable listing shows realistic 1/2/3-day tiers. */
const demoDayPrices = (unitPrice: number): string =>
  JSON.stringify({
    1: unitPrice,
    2: Math.round(unitPrice * 1.8),
    3: Math.round(unitPrice * 2.5),
  });

/** Prepare encrypted values for a single listing */
const prepareListing = async (
  index: number,
  maxAttendees: number,
  unitPrice: number,
  slug: string,
  slugIndex: string,
  customisable: boolean,
) => {
  const name = DEMO_LISTING_NAMES[index % DEMO_LISTING_NAMES.length]!;
  const description =
    DEMO_LISTING_DESCRIPTIONS[index % DEMO_LISTING_DESCRIPTIONS.length]!;
  const location =
    DEMO_LISTING_LOCATIONS[index % DEMO_LISTING_LOCATIONS.length]!;
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

  return insert("listings", {
    active: 1,
    attachment_name: encAttachmentName,
    attachment_url: encAttachmentUrl,
    bookable_days: JSON.stringify([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]),
    closes_at: encClosesAt,
    created,
    customisable_days: customisable ? 1 : 0,
    date: encDate,
    day_prices: customisable ? demoDayPrices(unitPrice) : "{}",
    description: encDesc,
    fields: "email",
    group_id: 0,
    image_url: encImageUrl,
    listing_type: "standard",
    location: encLoc,
    max_attendees: maxAttendees,
    max_quantity: 4,
    maximum_days_after: 90,
    minimum_days_before: 1,
    name: encName,
    non_transferable: 0,
    slug: encSlug,
    slug_index: slugIndex,
    thank_you_url: encThankYou,
    unit_price: unitPrice,
    webhook_url: encWebhook,
  });
};

/** Prepare encrypted values for a single attendee */
const prepareAttendee = async (
  listingId: number,
  quantity: number,
  unitPrice: number,
) => {
  const pricePaid = unitPrice * quantity;
  const paymentId =
    unitPrice > 0 ? `seed_${listingId}_${quantity}_${pricePaid}` : "";
  const enc = (await encryptAttendeeFields({
    address: randomChoice(DEMO_ADDRESSES),
    email: randomChoice(DEMO_EMAILS),
    name: randomChoice(DEMO_NAMES),
    paymentId,
    phone: randomChoice(DEMO_PHONES),
    pricePaid,
    special_instructions: randomChoice(DEMO_SPECIAL_INSTRUCTIONS),
  }))!;

  return [
    buildAttendeeInsert(enc, { remainingBalance: 0, statusId: null }),
    insert("listing_attendees", {
      attendee_id: rawSql("last_insert_rowid()"),
      listing_id: listingId,
      quantity,
    }),
  ];
};

/** Result of a seed operation */
export type SeedResult = {
  listingsCreated: number;
  attendeesCreated: number;
};

/**
 * Create seed listings and attendees using efficient batch writes.
 * Encrypts all data before inserting, matching production behavior.
 * Assigns random ticket quantities (1-4) per attendee without overselling.
 */
export const createSeeds = async (
  listingCount: number,
  attendeesPerListing: number,
): Promise<SeedResult> => {
  if (!settings.publicKey) throw new Error("Public key not configured");

  // Build structured listing data: quantities, capacity, price, and slug per listing
  const slugs = await generateUniqueSlugs(listingCount);
  const listingData = Array.from({ length: listingCount }, (_, i) => {
    const quantities = Array.from({ length: attendeesPerListing }, () =>
      randomQuantity(),
    );
    return {
      capacity: sum(quantities),
      index: i,
      quantities,
      slug: slugs[i]!,
      unitPrice: i % 2 === 0 ? randomChoice(DEMO_UNIT_PRICES) : 0,
    };
  });

  // Prepare and insert listings in a single batch
  const listingStatements = await Promise.all(
    map((d: (typeof listingData)[number]) =>
      prepareListing(
        d.index,
        d.capacity,
        d.unitPrice,
        d.slug.slug,
        d.slug.slugIndex,
        // Showcase the customisable-days feature on the first (always-priced)
        // demo listing so it appears in any seeded dataset.
        d.index === 0,
      ),
    )(listingData),
  );
  await executeBatch(listingStatements);

  // Query the newly created listing IDs (ordered by id DESC, limit to listingCount)
  const rows = await queryAll<{ id: number }>(
    "SELECT id FROM listings ORDER BY id DESC LIMIT ?",
    [listingCount],
  );
  const listingIds = map((r: { id: number }) => r.id)(rows).reverse();

  // Prepare all attendee inserts in parallel, in chunks to avoid memory pressure
  const CHUNK_SIZE = 50;
  let totalAttendees = 0;

  for (const [e, listingId] of listingIds.entries()) {
    const { quantities, unitPrice } = listingData[e]!;

    for (let offset = 0; offset < attendeesPerListing; offset += CHUNK_SIZE) {
      const batchSize = Math.min(CHUNK_SIZE, attendeesPerListing - offset);
      const chunkQuantities = quantities.slice(offset, offset + batchSize);
      const statementPairs = await Promise.all(
        map((q: number) => prepareAttendee(listingId, q, unitPrice))(
          chunkQuantities,
        ),
      );
      // Each pair is [attendee INSERT, listing_attendees INSERT] — flatten in order
      // so each listing_attendees INSERT follows its attendee (last_insert_rowid works)
      await executeBatch(statementPairs.flat());
      totalAttendees += batchSize;
    }
  }

  return {
    attendeesCreated: totalAttendees,
    listingsCreated: listingCount,
  };
};
