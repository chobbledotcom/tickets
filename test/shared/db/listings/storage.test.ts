import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { execute, getDb } from "#db/client.ts";
import { fieldCodecs } from "#db/codecs/fields.ts";
import { json } from "#db/codecs/kinds.ts";
import { openItemImages } from "#db/images.ts";
import {
  createListing,
  getListingWithCount,
  updateListing,
} from "#db/listings/records.ts";
import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { testCases } from "#test-utils/case-table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { listingRowStatement } from "#test-utils/db-helpers/listing-row.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { DayPricesSchema, MAX_DURATION_DAYS } from "#types";

const LISTING_CODECS = fieldCodecs("listings", LISTING_FIELDS);

/** The codec of the day prices that a listing read projects. */
const storedDayPrices = json(DayPricesSchema, "listings.day_prices");

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  const errors = setupErrorSpy();

  /** A listing with the standard test values, under the given slug. */
  const insertListing = async (
    slug: string,
    fields: Partial<ListingInput> = {},
  ) =>
    createListing({
      maxAttendees: 100,
      maxPrice: 10000,
      name: slug,
      slug,
      slugIndex: await hmacHash(slug),
      ...fields,
    });

  test("applies every listing storage default", async () => {
    const listing = await insertListing("storage-defaults");
    const saved = await getListingWithCount(listing.id);
    expect(saved).toMatchObject({
      active: true,
      assignBuiltSite: false,
      bookableAlone: false,
      canPayMore: false,
      customisableDays: false,
      durationDays: 1,
      fields: "email",
      hidden: false,
      initialSiteMonths: 0,
      listingType: "standard",
      maximumDaysAfter: 90,
      maxPrice: 10000,
      maxQuantity: 1,
      minimumDaysBefore: 1,
      monthsPerUnit: 0,
      nonTransferable: false,
      purchaseOnly: false,
      unitPrice: 0,
      useDefaults: false,
      usesLogistics: false,
    });
  });

  test("a bare row takes its numeric defaults from the table", async () => {
    await execute(await listingRowStatement("bare defaults"));
    const [row] = await readRows(
      from(tables.listings).pick("durationDays", "maxPrice"),
    );
    expect(row).toEqual({ durationDays: 1, maxPrice: 0 });
  });

  test("names each projected image when its stored filename is broken", async () => {
    const stored = await encrypt("");
    await openItemImages(
      { imageAltText: "", imageThumbUrl: stored, imageUrl: "" },
      "listing 8",
    );
    assertStringIncludes(
      errors.lastMessage() ?? "",
      "listing 8 thumbnail image",
    );
    await openItemImages(
      { imageAltText: "", imageThumbUrl: "", imageUrl: stored },
      "listing 9",
    );
    assertStringIncludes(errors.lastMessage() ?? "", "listing 9 image");
  });

  describe("date and closes_at read transforms", () => {
    test("reads an encrypted empty stored date as empty", async () => {
      expect(await LISTING_CODECS.date.decode(await encrypt(""), 1)).toBe("");
    });

    test("names stored datetime when a decrypted date is invalid", async () => {
      await expect(
        LISTING_CODECS.date.decode(await encrypt("not-a-dateZ"), 1),
      ).rejects.toThrow("stored datetime has invalid datetime: not-a-dateZ");
    });

    /** The `column` value of the listing saved with `fields` under `slug`. */
    const savedValue = async (
      slug: string,
      fields: Partial<ListingInput>,
      column: "date" | "closesAt",
    ): Promise<unknown> => {
      const listing = await insertListing(slug, fields);
      return (await getListingWithCount(listing.id))?.[column];
    };

    for (const [name, slug, fields, column, expected] of [
      [
        "returns empty string for no-date listing",
        "test-date-read-1",
        { date: "" },
        "date",
        "",
      ],
      [
        "normalizes a timezone offset to UTC",
        "test-date-read-2",
        { date: "2026-06-15T14:00:00+02:00" },
        "date",
        "2026-06-15T12:00:00.000Z",
      ],
      [
        "returns null for no-deadline listing",
        "test-read-1",
        { closesAt: "" },
        "closesAt",
        null,
      ],
      [
        "returns normalized ISO string for valid datetime",
        "test-read-2",
        { closesAt: "2099-12-31T23:59" },
        "closesAt",
        "2099-12-31T23:59:00.000Z",
      ],
    ] as const) {
      test(name, async () => {
        expect(await savedValue(slug, fields, column)).toBe(expected);
      });
    }

    for (const [name, slug, fields, column] of [
      [
        "rejects an invalid date",
        "test-date-read-invalid",
        { date: "not-a-dateZ" },
        "date",
      ],
      [
        "names closes_at when rejecting an invalid date",
        "test-closes-invalid",
        { closesAt: "not-a-dateZ" },
        "closes_at",
      ],
    ] as const) {
      test(name, async () => {
        await expect(insertListing(slug, fields)).rejects.toThrow(
          `${column} has invalid datetime: not-a-dateZ`,
        );
      });
    }
  });

  describe("duration_days write validation", () => {
    const insertWithDuration = async (slug: string, durationDays: number) => {
      const listing = await insertListing(slug, { durationDays });
      return (await getListingWithCount(listing.id))!.durationDays;
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
      const listing = await insertListing("test-dur-upd");
      await updateListing(listing.id, {
        durationDays: MAX_DURATION_DAYS + 1,
      });
      expect((await getListingWithCount(listing.id))!.durationDays).toBe(
        MAX_DURATION_DAYS,
      );
    });
  });

  describe("bookable_days read transform", () => {
    /** Store `stored` as a fresh listing's raw bookable_days text. */
    const storeBookableDays = async (slug: string, stored: string) => {
      const listing = await insertListing(slug);
      await getDb().execute(
        sql`UPDATE listings SET bookable_days = ${stored} WHERE id = ${listing.id}`,
      );
      return listing;
    };

    testCases(
      {
        "rejects malformed JSON stored in the database": ["test-bd-json", "["],
        "rejects mixed element types stored in the database": [
          "test-bd-2",
          '["Monday",1]',
        ],
        "rejects non-array JSON stored in the database": [
          "test-bd-1",
          '"not-an-array"',
        ],
      },
      async (slug, stored) => {
        const listing = await storeBookableDays(slug, stored);
        await expect(getListingWithCount(listing.id)).rejects.toThrow(
          `Invalid stored JSON in listings.bookable_days row ${listing.id}`,
        );
      },
    );

    test("preserves unknown day names for catalog repair", async () => {
      const listing = await storeBookableDays(
        "test-bd-day",
        '["Monday","Funday"]',
      );
      expect((await getListingWithCount(listing.id))?.bookableDays).toEqual([
        "Monday",
        "Funday",
      ]);
    });
  });

  describe("day_prices read transform", () => {
    test("accepts a stored day-price object", () => {
      expect(storedDayPrices.decode('{"1":100,"2":180}', 7)).toEqual({
        1: 100,
        2: 180,
      });
    });

    test("rejects arrays, invalid keys, and invalid prices", () => {
      for (const stored of ["[]", '{"0":100}', '{"1":"100"}']) {
        expect(() => storedDayPrices.decode(stored, 7)).toThrow(
          "Invalid stored JSON in listings.day_prices row 7",
        );
      }
    });

    test("rejects colliding canonical and leading-zero day keys", () => {
      expect(() => storedDayPrices.decode('{"01":100,"1":200}', 7)).toThrow(
        "Invalid stored JSON in listings.day_prices row 7",
      );
    });
  });
});
