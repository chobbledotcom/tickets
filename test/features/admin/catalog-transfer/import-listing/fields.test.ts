import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireListingWithCount } from "#db/listings/records.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { requireEntityImport } from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** One accepted blob: the name of the case, the blob, and the stored fields it
 *  must produce. */
type AcceptedCase = readonly [
  name: string,
  listing: Record<string, unknown>,
  stored: Record<string, unknown>,
];

/** One refused blob: the name of the case, the blob, and the message naming
 *  the field at fault. */
type RefusedCase = readonly [
  name: string,
  listing: Record<string, unknown>,
  contains: string,
];

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

/** Import a one-listing blob that must be accepted, and assert the stored row
 * carries `stored`. */
const expectStoredImport = async (
  listing: Record<string, unknown>,
  stored: Record<string, unknown>,
): Promise<void> => {
  const result = await importCatalog({ kind: "listing", listing, version: 1 });
  const imported = await requireListingWithCount(
    requireEntityImport(result).id,
  );
  expect(imported).toMatchObject(stored);
};

// The listing form validates field VALUES (datetime, duration cap, contact
// fields, weekday names) via its field definitions; the catalog import builds a
// listing directly, so the transfer schema re-checks the same rules at its wire
// boundary. Kept in their own file so these value-validation imports don't push
// the main catalog-transfer suite's cumulative per-request read count over the
// N+1 guard.
describeWithEnv("catalog-transfer field validation", { db: true }, () => {
  /* jscpd:ignore-start -- a table of cases, not code */
  const accepted: readonly AcceptedCase[] = [
    [
      "imports a minimum quantity and stores it",
      { maxAttendees: 1, maxQuantity: 5, minQuantity: 2, name: "Batched" },
      { min_quantity: 2 },
    ],
    [
      "defaults an absent minimum quantity to the stored 1",
      { maxAttendees: 1, name: "No Floor" },
      { min_quantity: 1 },
    ],
    [
      // With an explicit offset and without one (treated as UTC).
      "accepts datetimes with and without a timezone suffix",
      {
        closesAt: "2026-06-01T12:00:00Z",
        date: "2026-06-02T09:00:00",
        maxAttendees: 1,
        name: "Timed Listing",
      },
      {
        closes_at: "2026-06-01T12:00:00.000Z",
        date: "2026-06-02T09:00:00.000Z",
      },
    ],
    [
      "accepts a naive datetime without seconds",
      { closesAt: "2026-06-01T12:00", maxAttendees: 1, name: "NoSec" },
      { closes_at: "2026-06-01T12:00:00.000Z" },
    ],
    [
      "accepts fractional seconds after a seconds component",
      {
        closesAt: "2030-01-01T00:00:00.500Z",
        maxAttendees: 1,
        name: "Frac OK",
      },
      { closes_at: "2030-01-01T00:00:00.500Z" },
    ],
    [
      "accepts an explicitly empty closesAt (never closes)",
      { closesAt: "", maxAttendees: 1, name: "Open Listing" },
      { closes_at: null },
    ],
    [
      "accepts valid bookable day names",
      {
        bookableDays: ["Monday", "Wednesday"],
        listingType: "daily",
        maxAttendees: 1,
        name: "Good Days",
      },
      { bookable_days: ["Monday", "Wednesday"] },
    ],
  ];

  const refused: readonly RefusedCase[] = [
    [
      "rejects a minimum quantity below one",
      { maxAttendees: 1, minQuantity: 0, name: "Zero Floor" },
      "minQuantity",
    ],
    [
      // The shared listing-input rule runs inside the import transaction, so
      // the pairing refusal lands before any insert.
      "rejects a minimum quantity above the maximum",
      {
        maxAttendees: 1,
        maxQuantity: 2,
        minQuantity: 3,
        name: "High Floor",
      },
      "Min tickets per purchase must not be more than Max tickets per purchase",
    ],
    [
      "rejects a non-date closesAt",
      { closesAt: "not-a-date", maxAttendees: 1, name: "Bad Close" },
      "closesAt",
    ],
    [
      "rejects a non-date event date",
      { date: "soon", maxAttendees: 1, name: "Bad Date" },
      "date",
    ],
    [
      // A real-looking but non-existent date (Feb 30) must be a field error,
      // not silently rolled over into March by the storage layer.
      "rejects an impossible calendar date",
      { closesAt: "2026-02-30T00:00:00Z", maxAttendees: 1, name: "Imp" },
      "closesAt",
    ],
    [
      // Hour 25 is not a valid time even though the calendar date exists.
      "rejects an out-of-range time",
      { closesAt: "2026-06-01T25:00:00Z", maxAttendees: 1, name: "BadTime" },
      "closesAt",
    ],
    [
      // A valid prefix followed by garbage ("…T00:00not-a-zone") must be a
      // field error, not stored as an empty datetime.
      "rejects a datetime with trailing junk",
      { closesAt: "2030-01-01T00:00not-a-zone", maxAttendees: 1, name: "Junk" },
      "closesAt",
    ],
    [
      // A well-formed prefix with an impossible timezone offset ("+99:99") must
      // be a field error, not stored as an empty datetime by the normaliser.
      "rejects a datetime with an out-of-range offset",
      { closesAt: "2030-01-01T00:00+99:99", maxAttendees: 1, name: "Offset" },
      "closesAt",
    ],
    [
      // 1e100 is an "integer" to Number.isInteger but not safe; the money layer
      // rejects such minor-unit amounts, so the import must too rather than
      // round it or throw a raw storage error.
      "rejects a price above the safe-integer range",
      { maxAttendees: 1, name: "Rich", unitPrice: 1e100 },
      "unitPrice",
    ],
    [
      // Fractional seconds are only meaningful after a seconds field; a bare
      // "T00:00.123Z" is not a real instant and the storage layer would empty
      // it.
      "rejects fractional seconds without a seconds component",
      { closesAt: "2030-01-01T00:00.123Z", maxAttendees: 1, name: "Frac" },
      "closesAt",
    ],
    [
      // durationDays above the 90-day max is a field error, not silently
      // clamped by the storage normaliser.
      "rejects an over-cap duration",
      { durationDays: 365, maxAttendees: 1, name: "Too Long" },
      "90",
    ],
    [
      "rejects an unknown contact field",
      { fields: "email,fax", maxAttendees: 1, name: "Bad Fields" },
      "fields",
    ],
    [
      "rejects an invalid bookable day name",
      {
        bookableDays: ["Funday"],
        listingType: "daily",
        maxAttendees: 1,
        name: "Bad Days",
      },
      "bookableDays",
    ],
  ];
  /* jscpd:ignore-end */

  for (const [name, listing, stored] of accepted) {
    test(name, async () => {
      await expectStoredImport(listing, stored);
    });
  }

  for (const [name, listing, contains] of refused) {
    test(name, async () => {
      await expectListingImportError(listing, contains);
    });
  }
});
