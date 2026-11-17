/**
 * Seed data generation for populating the database with sample listings and attendees.
 * Uses batch writes for efficient database operations.
 */

import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { generateTicketToken } from "#crypto/utils.ts";
import { buildAttendeeInsert } from "#db/attendees/create.ts";
import { attendeeByToken } from "#db/attendees/create-batch.ts";
import { encryptAttendeeFields } from "#db/attendees/pii.ts";
import { executeBatch, queryAll } from "#db/client.ts";
import { syncListingPricesForIds } from "#db/listing-price-sync.ts";
import { dayCountPriceStatements } from "#db/listing-prices.ts";
import { valued } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { chunk, map, range, sum } from "#fp";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
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
} from "#shared/demo/samples.ts";
import { nowIso } from "#shared/now.ts";
import { generateUniqueSlug, type SlugWithIndex } from "#shared/slug.ts";

/** Max attendees per seeded listing */
export const SEED_MAX_ATTENDEES = 100_000;

/** Max listings that can be created in a single seed operation */
export const MAX_SEED_LISTINGS = 30;

/** Pick a random ticket quantity (1-4) */
const randomQuantity = (): number => 1 + Math.floor(Math.random() * 4);

/** Sample unit prices in minor units (e.g. pence/cents) for paid listings */
const DEMO_UNIT_PRICES = [500, 1000, 1500, 2000, 2500, 3000, 5000];

/** Generate slugs that are unique within the batch. The slugs made so far are
 * the only "already taken" list — nothing is in the database yet. */
const generateUniqueSlugs = async (
  count: number,
): Promise<SlugWithIndex<BlindIndex>[]> => {
  const results: SlugWithIndex<BlindIndex>[] = [];
  for (const _slot of range(0, count)) {
    results.push(
      await generateUniqueSlug(hmacHash, (slug) =>
        Promise.resolve(results.some((made) => made.slug === slug)),
      ),
    );
  }
  return results;
};

/** Demo day-count prices derived from a base (1-day) price, so the seeded
 * customisable listing shows realistic 1/2/3-day tiers. */
const demoDayPrices = (unitPrice: number): Record<number, number> => ({
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
  slugIndex: BlindIndex,
  customisable: boolean,
) => {
  const name = DEMO_LISTING_NAMES[index % DEMO_LISTING_NAMES.length]!;
  const description =
    DEMO_LISTING_DESCRIPTIONS[index % DEMO_LISTING_DESCRIPTIONS.length]!;
  const location =
    DEMO_LISTING_LOCATIONS[index % DEMO_LISTING_LOCATIONS.length]!;
  const created = nowIso();

  const [encName, encSlug, encDesc, encLoc] = await Promise.all([
    encrypt(name),
    encrypt(slug),
    encrypt(description),
    encrypt(location),
  ]);
  // The six remaining fields all seed the empty string, so one ciphertext
  // serves them all — each decrypts to "" exactly as before.
  const empty = await encrypt("");

  return insertInto(tables.listings, {
    active: 1,
    attachmentName: empty,
    attachmentUrl: empty,
    bookableDays: JSON.stringify(VALID_DAY_NAMES),
    closesAt: empty,
    created,
    customisableDays: customisable ? 1 : 0,
    date: empty,
    description: encDesc,
    fields: "email",
    listingType: "standard",
    location: encLoc,
    maxAttendees: maxAttendees,
    maximumDaysAfter: 90,
    maxQuantity: 4,
    minimumDaysBefore: 1,
    name: encName,
    nonTransferable: 0,
    slug: encSlug,
    slugIndex: slugIndex,
    thankYouUrl: empty,
    unitPrice: unitPrice,
    webhookUrl: empty,
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
  const enc = await encryptAttendeeFields(
    {
      address: randomChoice(DEMO_ADDRESSES),
      email: randomChoice(DEMO_EMAILS),
      name: randomChoice(DEMO_NAMES),
      paymentId,
      phone: randomChoice(DEMO_PHONES),
      special_instructions: randomChoice(DEMO_SPECIAL_INSTRUCTIONS),
    },
    generateTicketToken(),
  );

  return [
    buildAttendeeInsert(enc, { statusId: null }),
    insertInto(tables.listing_attendees, {
      attendeeId: valued<number>(attendeeByToken(enc.ticketTokenIndex)),
      listingId: listingId,
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
      // Showcase the customisable-days feature on the first (always-priced) demo
      // listing so it appears in any seeded dataset.
      customisable: i === 0,
      index: i,
      quantities,
      slug: slugs[i]!,
      // Paid listings walk the sample prices in order, so a big enough demo
      // set shows every tier and a test can name each one.
      unitPrice:
        i % 2 === 0 ? DEMO_UNIT_PRICES[(i / 2) % DEMO_UNIT_PRICES.length]! : 0,
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
        d.customisable,
      ),
    )(listingData),
  );
  await executeBatch(listingStatements);

  // Query the newly created listing IDs (ordered by id DESC, limit to listingCount)
  const rows = await queryAll<{ id: number }>(
    sql`SELECT id FROM listings ORDER BY id DESC LIMIT ${listingCount}`,
  );
  const listingIds = map((r: { id: number }) => r.id)(rows).reverse();

  // The seed inserts listings via raw batch statements (not listingsTable), so
  // populate their listing_prices rows the same way an admin write would: `base`
  // from the unit_price column, and `day_count` rows from the demo day prices for
  // the customisable listings (day prices are no longer a listings column).
  await syncListingPricesForIds(listingIds);
  const dayCountStatements = listingData
    .filter((d) => d.customisable)
    .flatMap((d) =>
      dayCountPriceStatements(listingIds[d.index]!, demoDayPrices(d.unitPrice)),
    );
  if (dayCountStatements.length > 0) await executeBatch(dayCountStatements);

  // Prepare all attendee inserts in parallel, in chunks to avoid memory pressure
  const CHUNK_SIZE = 50;
  let totalAttendees = 0;

  for (const [e, listingId] of listingIds.entries()) {
    const { quantities, unitPrice } = listingData[e]!;

    for (const chunkQuantities of chunk(CHUNK_SIZE)(quantities)) {
      const statementPairs = await Promise.all(
        map((q: number) => prepareAttendee(listingId, q, unitPrice))(
          chunkQuantities,
        ),
      );
      // Each booking locates its attendee by the caller-supplied stable token.
      await executeBatch(statementPairs.flat());
      totalAttendees += chunkQuantities.length;
    }
  }

  return {
    attendeesCreated: totalAttendees,
    listingsCreated: listingCount,
  };
};
