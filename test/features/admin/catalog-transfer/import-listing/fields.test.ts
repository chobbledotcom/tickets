import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireListingWithCount } from "#db/listings/records.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { requireEntityImport } from "#test-utils/catalog-import.ts";
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
  assertStringIncludes(result.error, contains);
};

/** Import a one-listing blob and read back the stored listing. */
const importStoredListing = async (listing: Record<string, unknown>) =>
  requireListingWithCount(
    requireEntityImport(
      await importCatalog({ kind: "listing", listing, version: 1 }),
    ).id,
  );

/** A listing the import refuses: the extra fields beside the required
 * `maxAttendees: 1`, and a fragment the refusal message must carry. */
type ImportRefusal = {
  label: string;
  listing: Record<string, unknown>;
  contains: string;
};

/** closesAt values the import refuses, keyed by the test label. */
const refusedClosesAt: Record<string, string> = {
  "refuses a naive datetime: the file must name a UTC time": "2026-06-01T12:00",
  "refuses an empty closesAt: null means no closing time": "",
  // A well-formed prefix with an impossible timezone offset ("+99:99") must be
  // a field error, not stored as an empty datetime by the storage normaliser.
  "rejects a datetime with an out-of-range offset": "2030-01-01T00:00+99:99",
  // A valid prefix followed by garbage ("…T00:00not-a-zone") must be a field
  // error, not stored as an empty datetime.
  "rejects a datetime with trailing junk": "2030-01-01T00:00not-a-zone",
  "rejects a non-date closesAt": "not-a-date",
  // A real-looking but non-existent date (Feb 30) must be a field error, not
  // silently rolled over into March by the storage layer.
  "rejects an impossible calendar date": "2026-02-30T00:00:00Z",
  // Hour 25 is not a valid time even though the calendar date exists.
  "rejects an out-of-range time": "2026-06-01T25:00:00Z",
  // Fractional seconds are only meaningful after a seconds field; a bare
  // "T00:00.123Z" is not a real instant and the storage layer would empty it.
  "rejects fractional seconds without a seconds component":
    "2030-01-01T00:00.123Z",
};

const importRefusals: ImportRefusal[] = [
  {
    contains: "minQuantity",
    label: "rejects a minimum quantity below one",
    listing: { minQuantity: 0, name: "Zero Floor" },
  },
  {
    // The shared listing-input rule runs inside the import transaction, so
    // the pairing refusal lands before any insert.
    contains:
      "Min tickets per purchase must not be more than Max tickets per purchase",
    label: "rejects a minimum quantity above the maximum",
    listing: { maxQuantity: 2, minQuantity: 3, name: "High Floor" },
  },
  {
    contains: "date",
    label: "rejects a non-date event date",
    listing: { date: "soon", name: "Bad Date" },
  },
  ...Object.entries(refusedClosesAt).map(([label, closesAt]) => ({
    contains: "closesAt",
    label,
    listing: { closesAt, name: label },
  })),
  {
    // 1e100 is an "integer" to Number.isInteger but not safe; the money layer
    // rejects such minor-unit amounts, so the import must too rather than round
    // it or throw a raw storage error.
    contains: "unitPrice",
    label: "rejects a price above the safe-integer range",
    listing: { name: "Rich", unitPrice: 1e100 },
  },
  {
    // durationDays above the 90-day max is a field error, not silently clamped
    // by the storage normaliser.
    contains: "90",
    label: "rejects an over-cap duration",
    listing: { durationDays: 365, name: "Too Long" },
  },
  {
    contains: "fields",
    label: "rejects an unknown contact field",
    listing: { fields: "email,fax", name: "Bad Fields" },
  },
  {
    contains: "bookableDays",
    label: "rejects an invalid bookable day name",
    listing: {
      bookableDays: ["Funday"],
      listingType: "daily",
      name: "Bad Days",
    },
  },
];

// The listing form validates field VALUES (datetime, duration cap, contact
// fields, weekday names) via its field definitions; the catalog import builds a
// listing directly, so the transfer schema re-checks the same rules at its wire
// boundary. Kept in their own file so these value-validation imports don't push
// the main catalog-transfer suite's cumulative per-request read count over the
// N+1 guard.
describeWithEnv("catalog-transfer field validation", { db: true }, () => {
  test("imports a minimum quantity and stores it", async () => {
    const imported = await importStoredListing({
      maxAttendees: 1,
      maxQuantity: 5,
      minQuantity: 2,
      name: "Batched",
    });
    expect(imported.minQuantity).toBe(2);
  });

  test("defaults an absent minimum quantity to the stored 1", async () => {
    const imported = await importStoredListing({
      maxAttendees: 1,
      name: "No Floor",
    });
    expect(imported.minQuantity).toBe(1);
  });

  for (const { contains, label, listing } of importRefusals) {
    test(label, async () => {
      await expectListingImportError({ maxAttendees: 1, ...listing }, contains);
    });
  }

  test("stores each UTC datetime as a full instant, fractional seconds kept", async () => {
    const timed = await importStoredListing({
      closesAt: "2026-06-01T12:00:00Z",
      date: "2026-06-02T09:00Z",
      maxAttendees: 1,
      name: "Timed Listing",
    });
    const fractional = await importStoredListing({
      closesAt: "2030-01-01T00:00:00.500Z",
      maxAttendees: 1,
      name: "Frac OK",
    });
    expect([timed.closesAt, timed.date, fractional.closesAt]).toEqual([
      "2026-06-01T12:00:00.000Z",
      "2026-06-02T09:00:00.000Z",
      "2030-01-01T00:00:00.500Z",
    ]);
  });

  test("stores a null closesAt as no closing time, and the column default max price", async () => {
    const imported = await importStoredListing({
      closesAt: null,
      maxAttendees: 1,
      name: "Open Listing",
    });
    expect([imported.closesAt, imported.maxPrice]).toEqual([null, 0]);
  });

  test("accepts valid bookable day names", async () => {
    const imported = await importStoredListing({
      bookableDays: ["Monday", "Wednesday"],
      listingType: "daily",
      maxAttendees: 1,
      name: "Good Days",
    });
    expect(imported.bookableDays).toEqual(["Monday", "Wednesday"]);
  });
});
