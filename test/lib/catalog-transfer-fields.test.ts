import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { getListing } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils";

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
    if (!result.ok) throw new Error(result.error);
    const imported = (await getListing(result.id))!;
    expect(imported.closes_at).toContain("2026-06-01");
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
    if (!result.ok) throw new Error(result.error);
    expect((await getListing(result.id))!.closes_at).toContain("2026-06-01");
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

  test("accepts an explicitly empty closesAt (never closes)", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: { closesAt: "", maxAttendees: 1, name: "Open Listing" },
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await getListing(result.id))!.closes_at).toBeNull();
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
    if (!result.ok) throw new Error(result.error);
    expect((await getListing(result.id))!.bookable_days).toContain("Monday");
  });
});
