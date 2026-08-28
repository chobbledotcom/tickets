import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { getDb } from "#db/client.ts";
import { getListingWithCount, listingsTable } from "#db/listings/records.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { type DayPrices, MAX_DURATION_DAYS } from "#types";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  const errors = setupErrorSpy();

  test("applies every listing storage default", async () => {
    const listing = await listingsTable.insert({
      maxAttendees: 100,
      maxPrice: 10000,
      name: "defaults",
      slug: "storage-defaults",
      slugIndex: await hmacHash("storage-defaults"),
    });
    const saved = await getListingWithCount(listing.id);
    expect(saved).toMatchObject({
      active: true,
      assign_built_site: false,
      bookable_alone: false,
      can_pay_more: false,
      customisable_days: false,
      duration_days: 1,
      fields: "email",
      hidden: false,
      initial_site_months: 0,
      listing_type: "standard",
      max_price: 10000,
      max_quantity: 1,
      maximum_days_after: 90,
      minimum_days_before: 1,
      months_per_unit: 0,
      non_transferable: false,
      purchase_only: false,
      unit_price: 0,
      use_defaults: false,
      uses_logistics: false,
    });
  });

  test("applies numeric defaults at the raw table boundary", async () => {
    expect(rawListingsTable.schema.duration_days.default?.()).toBe(1);
    const listing = await rawListingsTable.insert({
      maxAttendees: 100,
      name: "raw defaults",
      slug: "raw-storage-defaults",
      slugIndex: await hmacHash("raw-storage-defaults"),
    } as ListingInput);
    expect(listing.duration_days).toBe(1);
    expect(listing.max_price).toBe(0);
  });

  test("names each projected image when its stored filename is broken", async () => {
    const stored = await encrypt("");
    await rawListingsTable.readColumn("image_thumb_url", stored, 8);
    expect(errors.lastMessage()).toContain("listing 8 thumbnail image");
    await rawListingsTable.readColumn("image_url", stored, 9);
    expect(errors.lastMessage()).toContain("listing 9 image");
  });

  describe("listing date read transform", () => {
    test("reads an encrypted empty stored date as empty", async () => {
      expect(await rawListingsTable.readColumn("date", await encrypt(""))).toBe(
        "",
      );
    });

    test("names stored datetime when a decrypted date is invalid", async () => {
      await expect(
        rawListingsTable.readColumn("date", await encrypt("not-a-dateZ")),
      ).rejects.toThrow("stored datetime has invalid datetime: not-a-dateZ");
    });
    test("returns empty string for no-date listing", async () => {
      const listing = await listingsTable.insert({
        date: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-1",
        slugIndex: await hmacHash("test-date-read-1"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("");
    });

    test("normalizes a timezone offset to UTC", async () => {
      const listing = await listingsTable.insert({
        date: "2026-06-15T14:00:00+02:00",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-2",
        slugIndex: await hmacHash("test-date-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("2026-06-15T12:00:00.000Z");
    });

    test("rejects an invalid date", async () => {
      await expect(
        listingsTable.insert({
          date: "not-a-dateZ",
          maxAttendees: 100,
          maxPrice: 10000,
          name: "test",
          slug: "test-date-read-invalid",
          slugIndex: await hmacHash("test-date-read-invalid"),
        }),
      ).rejects.toThrow("date has invalid datetime: not-a-dateZ");
    });
  });

  describe("closes_at read transform", () => {
    test("returns null for no-deadline listing", async () => {
      const listing = await listingsTable.insert({
        closesAt: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-1",
        slugIndex: await hmacHash("test-read-1"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const listing = await listingsTable.insert({
        closesAt: "2099-12-31T23:59",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-2",
        slugIndex: await hmacHash("test-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });

    test("names closes_at when rejecting an invalid date", async () => {
      await expect(
        listingsTable.insert({
          closesAt: "not-a-dateZ",
          maxAttendees: 100,
          maxPrice: 10000,
          name: "test",
          slug: "test-closes-invalid",
          slugIndex: await hmacHash("test-closes-invalid"),
        }),
      ).rejects.toThrow("closes_at has invalid datetime: not-a-dateZ");
    });
  });

  describe("duration_days write validation", () => {
    const insertWithDuration = async (slug: string, durationDays: number) => {
      const listing = await listingsTable.insert({
        durationDays,
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug,
        slugIndex: await hmacHash(slug),
      });
      return (await getListingWithCount(listing.id))!.duration_days;
    };

    test("accepts whole days within the supported range", async () => {
      expect(
        await insertWithDuration("test-dur-valid", MAX_DURATION_DAYS),
      ).toBe(MAX_DURATION_DAYS);
    });

    test("clamps whole integers outside the supported range", async () => {
      expect(
        await insertWithDuration("test-dur-high", MAX_DURATION_DAYS + 1),
      ).toBe(MAX_DURATION_DAYS);
      expect(await insertWithDuration("test-dur-zero", 0)).toBe(1);
      expect(await insertWithDuration("test-dur-neg", -3)).toBe(1);
    });

    test("rejects fractional and non-finite values", async () => {
      for (const [slug, value] of [
        ["test-dur-frac", 2.7],
        ["test-dur-nan", Number.NaN],
      ] as const) {
        await expect(insertWithDuration(slug, value)).rejects.toThrow();
      }
    });

    test("clamps an out-of-range update", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug: "test-dur-upd",
        slugIndex: await hmacHash("test-dur-upd"),
      });
      await listingsTable.update(listing.id, {
        durationDays: MAX_DURATION_DAYS + 1,
      });
      expect((await getListingWithCount(listing.id))!.duration_days).toBe(
        MAX_DURATION_DAYS,
      );
    });
  });

  describe("bookable_days read transform", () => {
    test("rejects malformed JSON stored in the database", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd-json",
        slug: "test-bd-json",
        slugIndex: await hmacHash("test-bd-json"),
      });
      await getDb().execute({
        args: ["[", listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      await expect(getListingWithCount(listing.id)).rejects.toThrow(
        `Invalid stored JSON in listings.bookable_days row ${listing.id}`,
      );
    });

    test("rejects non-array JSON stored in the database", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd",
        slug: "test-bd-1",
        slugIndex: await hmacHash("test-bd-1"),
      });
      await getDb().execute({
        args: ['"not-an-array"', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      await expect(getListingWithCount(listing.id)).rejects.toThrow(
        `Invalid stored JSON in listings.bookable_days row ${listing.id}`,
      );
    });

    test("rejects mixed element types stored in the database", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd-types",
        slug: "test-bd-2",
        slugIndex: await hmacHash("test-bd-2"),
      });
      await getDb().execute({
        args: ['["Monday",1]', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      await expect(getListingWithCount(listing.id)).rejects.toThrow(
        `Invalid stored JSON in listings.bookable_days row ${listing.id}`,
      );
    });

    test("preserves unknown day names for catalog repair", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd-day",
        slug: "test-bd-day",
        slugIndex: await hmacHash("test-bd-day"),
      });
      await getDb().execute({
        args: ['["Monday","Funday"]', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      expect((await getListingWithCount(listing.id))?.bookable_days).toEqual([
        "Monday",
        "Funday",
      ]);
    });
  });

  describe("day_prices read transform", () => {
    test("accepts a stored day-price object", async () => {
      expect(
        await rawListingsTable.readColumn(
          "day_prices",
          '{"1":100,"2":180}' as unknown as DayPrices,
        ),
      ).toEqual({ 1: 100, 2: 180 });
    });

    test("rejects arrays, invalid keys, and invalid prices", async () => {
      for (const stored of ["[]", '{"0":100}', '{"1":"100"}']) {
        await expect(
          rawListingsTable.readColumn(
            "day_prices",
            stored as unknown as DayPrices,
            7,
          ),
        ).rejects.toThrow("Invalid stored JSON in listings.day_prices row 7");
      }
    });

    test("rejects colliding canonical and leading-zero day keys", async () => {
      await expect(
        rawListingsTable.readColumn(
          "day_prices",
          '{"01":100,"1":200}' as unknown as DayPrices,
          7,
        ),
      ).rejects.toThrow("Invalid stored JSON in listings.day_prices row 7");
    });
  });
});
