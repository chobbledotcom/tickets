import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sum } from "#fp";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { getListingDayPrices } from "#shared/db/listing-prices.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { DEMO_EMAILS, DEMO_NAMES } from "#shared/demo/samples.ts";
import { createSeeds, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("seeds", { db: true }, () => {
  test("caps a seeded listing's attendees at a hundred thousand", () => {
    expect(SEED_MAX_ATTENDEES).toBe(100_000);
  });

  test("reports exactly what it created", async () => {
    const result = await createSeeds(3, 2);
    expect(result).toEqual({ attendeesCreated: 6, listingsCreated: 3 });
    expect((await getAllListings()).length).toBe(3);
  });

  test("a listing with no attendees seeds cleanly with zero capacity", async () => {
    const result = await createSeeds(1, 0);
    expect(result).toEqual({ attendeesCreated: 0, listingsCreated: 1 });
    const [listing] = await getAllListings();
    expect(listing!.max_attendees).toBe(0);
  });

  test("every other listing is paid, walking the sample prices in order", async () => {
    // Enough listings to walk the whole price set and wrap back around.
    await createSeeds(16, 0);
    const prices = (await getAllListings())
      .toSorted((a, b) => a.id - b.id)
      .map((listing) => listing.unit_price);
    expect(prices).toEqual([
      500, 0, 1000, 0, 1500, 0, 2000, 0, 2500, 0, 3000, 0, 5000, 0, 500, 0,
    ]);
  });

  test("only the first listing is customisable, with 1/2/3-day demo prices", async () => {
    await createSeeds(2, 0);
    const listings = (await getAllListings()).toSorted((a, b) => a.id - b.id);
    expect(listings[0]!.customisable_days).toBe(true);
    expect(listings[1]!.customisable_days).toBe(false);

    // The tiers derive from the base price: 1 day at base, 2 days at 1.8x,
    // 3 days at 2.5x, rounded to whole minor units.
    const base = listings[0]!.unit_price;
    const dayPrices = await getListingDayPrices(listings[0]!.id);
    expect(dayPrices).toEqual({
      1: base,
      2: Math.round(base * 1.8),
      3: Math.round(base * 2.5),
    });
    // The projection on the listing row agrees with the stored rows.
    expect(listings[0]!.day_prices).toEqual(dayPrices);
  });

  test("capacity equals the booked quantities, which vary between 1 and 4", async () => {
    // One listing with a large draw, so a quantity outside 1-4 (or a die that
    // stopped varying) cannot hide.
    await createSeeds(1, 120);
    const [listing] = await getAllListings();
    const attendees = await getAttendeesRaw(listing!.id);
    expect(attendees.length).toBe(120);

    const quantities = attendees.map((attendee) => attendee.quantity);
    for (const quantity of quantities) {
      expect(quantity).toBeGreaterThanOrEqual(1);
      expect(quantity).toBeLessThanOrEqual(4);
    }
    expect(new Set(quantities).size).toBeGreaterThan(1);
    expect(listing!.max_attendees).toBe(sum(quantities));
  });

  test("a paid booking carries its price and a seed payment id", async () => {
    // One listing seeds the always-priced first demo listing.
    await createSeeds(1, 1);
    const [listing] = await getAllListings();
    const raw = await getAttendeesRaw(listing!.id);
    const [attendee] = await decryptAttendees(raw, await getTestPrivateKey());

    expect(DEMO_NAMES).toContain(attendee!.name);
    expect(DEMO_EMAILS).toContain(attendee!.email);
    // The seed payment id embeds the booking's worth: unit price x quantity.
    const worth = listing!.unit_price * raw[0]!.quantity;
    expect(attendee!.payment_id).toBe(
      `seed_${listing!.id}_${raw[0]!.quantity}_${worth}`,
    );
  });

  test("a free booking has no payment id", async () => {
    // Listing 2 (index 1) is free, so its booking must not invent a payment.
    await createSeeds(2, 1);
    const free = (await getAllListings()).find(
      (listing) => listing.unit_price === 0,
    );
    const raw = await getAttendeesRaw(free!.id);
    const [attendee] = await decryptAttendees(raw, await getTestPrivateKey());
    expect(attendee!.payment_id).toBe("");
  });

  test("each seeded listing gets its own slug", async () => {
    await createSeeds(3, 0);
    const rows = await getDb().execute("SELECT slug_index FROM listings");
    const indexes = rows.rows.map((row) => row.slug_index);
    expect(new Set(indexes).size).toBe(3);
  });

  test("throws when the public key is not configured", async () => {
    await getDb().execute("DELETE FROM settings WHERE key = 'public_key'");
    settings.invalidateCache();

    await expect(createSeeds(1, 0)).rejects.toThrow(
      "Public key not configured",
    );
  });
});
