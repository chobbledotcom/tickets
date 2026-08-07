import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
import { requireSuccess } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** Import a one-listing blob and assert it is rejected with a message naming
 * the offending field. */
const expectListingImportError = async (
  listing: Record<string, unknown>,
  contains: string,
): Promise<void> => {
  const result = await importCatalog({ kind: "listing", listing, version: 1 });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error).toContain(contains);
};

// The listing form validates field VALUES (datetime, duration cap, contact
// fields, weekday names) via its field definitions; the catalog import builds a
// listing directly, so the transfer schema re-checks the same rules at its wire
// boundary. Kept in their own file so these value-validation imports don't push
// the main catalog-transfer suite's cumulative per-request read count over the
// N+1 guard.
describeWithEnv("catalog-transfer field validation", { db: true }, () => {
  test("rejects a non-date closesAt", async () => {
    await expectListingImportError(
      { closesAt: "not-a-date", maxAttendees: 1, name: "Bad Close" },
      "closesAt",
    );
  });

  test("rejects a non-date event date", async () => {
    await expectListingImportError(
      { date: "soon", maxAttendees: 1, name: "Bad Date" },
      "date",
    );
  });

  test("accepts datetimes with and without a timezone suffix", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: {
        // With an explicit offset and without one (treated as UTC).
        closesAt: "2026-06-01T12:00:00Z",
        date: "2026-06-02T09:00:00",
        maxAttendees: 1,
        name: "Timed Listing",
      },
      version: 1,
    });
    const importedResult = requireSuccess(result);
    const imported = await requireListingWithCount(importedResult.id);
    expect(imported.closes_at).toBe("2026-06-01T12:00:00.000Z");
    expect(imported.date).toBe("2026-06-02T09:00:00.000Z");
  });

  test("rejects an impossible calendar date", async () => {
    // A real-looking but non-existent date (Feb 30) must be a field error, not
    // silently rolled over into March by the storage layer.
    await expectListingImportError(
      { closesAt: "2026-02-30T00:00:00Z", maxAttendees: 1, name: "Imp" },
      "closesAt",
    );
  });

  test("accepts a naive datetime without seconds", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: { closesAt: "2026-06-01T12:00", maxAttendees: 1, name: "NoSec" },
      version: 1,
    });
    const imported = await requireListingWithCount(requireSuccess(result).id);
    expect(imported.closes_at).toBe("2026-06-01T12:00:00.000Z");
  });

  test("rejects an out-of-range time", async () => {
    // Hour 25 is not a valid time even though the calendar date exists.
    await expectListingImportError(
      { closesAt: "2026-06-01T25:00:00Z", maxAttendees: 1, name: "BadTime" },
      "closesAt",
    );
  });

  test("rejects a datetime with trailing junk", async () => {
    // A valid prefix followed by garbage ("…T00:00not-a-zone") must be a field
    // error, not stored as an empty datetime.
    await expectListingImportError(
      { closesAt: "2030-01-01T00:00not-a-zone", maxAttendees: 1, name: "Junk" },
      "closesAt",
    );
  });

  test("rejects a datetime with an out-of-range offset", async () => {
    // A well-formed prefix with an impossible timezone offset ("+99:99") must be
    // a field error, not stored as an empty datetime by the storage normaliser.
    await expectListingImportError(
      { closesAt: "2030-01-01T00:00+99:99", maxAttendees: 1, name: "Offset" },
      "closesAt",
    );
  });

  test("rejects a price above the safe-integer range", async () => {
    // 1e100 is an "integer" to Number.isInteger but not safe; the money layer
    // rejects such minor-unit amounts, so the import must too rather than round
    // it or throw a raw storage error.
    await expectListingImportError(
      { maxAttendees: 1, name: "Rich", unitPrice: 1e100 },
      "unitPrice",
    );
  });

  test("rejects fractional seconds without a seconds component", async () => {
    // Fractional seconds are only meaningful after a seconds field; a bare
    // "T00:00.123Z" is not a real instant and the storage layer would empty it.
    await expectListingImportError(
      { closesAt: "2030-01-01T00:00.123Z", maxAttendees: 1, name: "Frac" },
      "closesAt",
    );
  });

  test("accepts fractional seconds after a seconds component", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: {
        closesAt: "2030-01-01T00:00:00.500Z",
        maxAttendees: 1,
        name: "Frac OK",
      },
      version: 1,
    });
    const imported = await requireListingWithCount(requireSuccess(result).id);
    expect(imported.closes_at).toBe("2030-01-01T00:00:00.500Z");
  });

  test("accepts an explicitly empty closesAt (never closes)", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: { closesAt: "", maxAttendees: 1, name: "Open Listing" },
      version: 1,
    });
    const imported = await requireListingWithCount(requireSuccess(result).id);
    expect(imported.closes_at).toBeNull();
  });

  test("rejects an over-cap duration", async () => {
    // durationDays above the 90-day max is a field error, not silently clamped
    // by the storage normaliser.
    await expectListingImportError(
      { durationDays: 365, maxAttendees: 1, name: "Too Long" },
      "90",
    );
  });

  test("rejects an unknown contact field", async () => {
    await expectListingImportError(
      { fields: "email,fax", maxAttendees: 1, name: "Bad Fields" },
      "fields",
    );
  });

  test("rejects an invalid bookable day name", async () => {
    await expectListingImportError(
      {
        bookableDays: ["Funday"],
        listingType: "daily",
        maxAttendees: 1,
        name: "Bad Days",
      },
      "bookableDays",
    );
  });

  test("accepts valid bookable day names", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: {
        bookableDays: ["Monday", "Wednesday"],
        listingType: "daily",
        maxAttendees: 1,
        name: "Good Days",
      },
      version: 1,
    });
    const imported = await requireListingWithCount(requireSuccess(result).id);
    expect(imported.bookable_days).toEqual(["Monday", "Wednesday"]);
  });
});
