import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import {
  catalogVisibleSql,
  computeSlugIndex,
  getListingWithCount,
  listingsTable,
  writeClosesAt,
  writeListingDate,
} from "#shared/db/listings.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils";

/** Decrypt a value written by `writeClosesAt`/`writeListingDate` — both
 * return an already-encrypted string (writeClosesAt's `null` still carries the
 * same runtime string type), so every test in this file needs the same
 * round-trip before asserting on the plaintext. */
const decryptWritten = async (encrypted: string | null): Promise<string> => {
  const { decrypt } = await import("#shared/crypto/encryption.ts");
  return decrypt(encrypted as unknown as string);
};

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("writeClosesAt", () => {
    test("encrypts empty string for no deadline", async () => {
      const result = await writeClosesAt("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      expect(await decryptWritten(result)).toBe("");
    });

    test("encrypts null as empty string", async () => {
      const result = await writeClosesAt(null);
      expect(await decryptWritten(result)).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const input = "2099-06-15T14:30";
      const result = await writeClosesAt(input);
      expect(await decryptWritten(result)).toBe(
        new Date(`${input}Z`).toISOString(),
      );
    });

    test("handles already-normalized ISO string", async () => {
      const result = await writeClosesAt("2099-06-15T14:30:00.000Z");
      expect(await decryptWritten(result)).toBe("2099-06-15T14:30:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const input = "2099-06-15T14:30:00-05:00";
      const result = await writeClosesAt(input);
      expect(await decryptWritten(result)).toBe(new Date(input).toISOString());
    });
  });

  describe("writeListingDate", () => {
    test("encrypts empty string for no date", async () => {
      const result = await writeListingDate("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      expect(await decryptWritten(result)).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const input = "2026-06-15T14:00";
      const result = await writeListingDate(input);
      expect(await decryptWritten(result)).toBe(
        new Date(`${input}Z`).toISOString(),
      );
    });

    test("handles already-normalized ISO string", async () => {
      const result = await writeListingDate("2026-06-15T14:00:00.000Z");
      expect(await decryptWritten(result)).toBe("2026-06-15T14:00:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const input = "2026-06-15T14:00:00+02:00";
      const result = await writeListingDate(input);
      expect(await decryptWritten(result)).toBe(new Date(input).toISOString());
    });

    test("returns empty string for invalid datetime", async () => {
      const errorSpy = spy(console, "error");
      const result = await writeListingDate("not-a-dateZ");
      expect(await decryptWritten(result)).toBe("");
      expect(errorSpy.calls.length).toBeGreaterThan(0);
      errorSpy.restore();
    });
  });

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

    test("returns normalized ISO string for valid datetime", async () => {
      const listing = await listingsTable.insert({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-2",
        slugIndex: await computeSlugIndex("test-date-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
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

    test("degrades non-finite values to the 1-day default", async () => {
      expect(await insertWithDuration("test-dur-nan", Number.NaN)).toBe(1);
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
    test("returns empty array when DB contains non-array JSON", async () => {
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
      const saved = await getListingWithCount(listing.id);
      expect(saved?.bookable_days).toEqual([]);
    });
  });
});

describe("shared > db > listings > catalogVisibleSql", () => {
  test("with no hidden default, only the stored flag matters", () => {
    expect(catalogVisibleSql(undefined)).toBe("listing.hidden = 0");
  });

  test("a Hidden=true default hides every inheriting non-renewal listing", () => {
    // Inheriting rows (use_defaults, not a renewal tier) are excluded even when
    // their stored hidden flag is 0, matching resolveListingDefaults.
    expect(catalogVisibleSql(true)).toBe(
      "listing.hidden = 0 AND NOT (listing.use_defaults = 1 AND listing.months_per_unit = 0)",
    );
  });

  test("a Hidden=false default reveals inheriting rows regardless of stored flag", () => {
    expect(catalogVisibleSql(false)).toBe(
      "((listing.use_defaults = 1 AND listing.months_per_unit = 0) OR listing.hidden = 0)",
    );
  });
});
