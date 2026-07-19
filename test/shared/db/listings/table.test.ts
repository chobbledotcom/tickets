import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { computeSlugIndex } from "#shared/db/listings/table.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("listing date read transform", () => {
    test("returns empty string for no-date listing", async () => {
      const listing = await listingsTable.insert({
        date: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-1",
        slugIndex: await computeSlugIndex("test-date-read-1"),
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
        slugIndex: await computeSlugIndex("test-date-read-2"),
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
          slugIndex: await computeSlugIndex("test-date-read-invalid"),
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
        slugIndex: await computeSlugIndex("test-read-1"),
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
        slugIndex: await computeSlugIndex("test-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });
  });

  describe("duration_days write clamp", () => {
    const insertWithDuration = async (slug: string, durationDays: number) => {
      const listing = await listingsTable.insert({
        durationDays,
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug,
        slugIndex: await computeSlugIndex(slug),
      });
      return (await getListingWithCount(listing.id))!.duration_days;
    };

    test(`clamps values above MAX_DURATION_DAYS down to ${MAX_DURATION_DAYS}`, async () => {
      expect(await insertWithDuration("test-dur-high", 500)).toBe(
        MAX_DURATION_DAYS,
      );
    });

    test("clamps zero to 1", async () => {
      expect(await insertWithDuration("test-dur-zero", 0)).toBe(1);
    });

    test("clamps negative values to 1", async () => {
      expect(await insertWithDuration("test-dur-neg", -3)).toBe(1);
    });

    test("floors fractional values to whole days", async () => {
      expect(await insertWithDuration("test-dur-frac", 2.7)).toBe(2);
    });

    test("rejects non-finite values", async () => {
      await expect(
        insertWithDuration("test-dur-nan", Number.NaN),
      ).rejects.toThrow("Invalid booking duration: NaN");
    });

    test("clamps on update as well as insert", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug: "test-dur-upd",
        slugIndex: await computeSlugIndex("test-dur-upd"),
      });
      await listingsTable.update(listing.id, { durationDays: 1000 });
      expect((await getListingWithCount(listing.id))!.duration_days).toBe(
        MAX_DURATION_DAYS,
      );
    });
  });

  describe("bookable_days read transform", () => {
    test("rejects non-array JSON stored in the database", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd",
        slug: "test-bd-1",
        slugIndex: await computeSlugIndex("test-bd-1"),
      });
      await getDb().execute({
        args: ['"not-an-array"', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      await expect(getListingWithCount(listing.id)).rejects.toThrow(
        "Stored bookable_days must be a JSON string array",
      );
    });

    test("rejects mixed element types stored in the database", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd-types",
        slug: "test-bd-2",
        slugIndex: await computeSlugIndex("test-bd-2"),
      });
      await getDb().execute({
        args: ['["Monday",1]', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      await expect(getListingWithCount(listing.id)).rejects.toThrow(
        "Stored bookable_days must be a JSON string array",
      );
    });
  });
});
