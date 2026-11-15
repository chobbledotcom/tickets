/**
 * Tests for `src/shared/db/read.ts`: the runners of a read from the builder.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readOneRow, readRows } from "#db/read.ts";
import { among } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const listingIds = (ids: readonly number[]) =>
  from(tables.listings)
    .where((listing) => among(listing.id, ids))
    .orderBy((listing) => [listing.id])
    .select((listing) => ({ id: listing.id }));

/** The ids of two stored listings, in the order of the database. */
const twoListingIds = async (): Promise<[number, number]> => {
  const first = await createTestListing({ name: "First" });
  const second = await createTestListing({ name: "Second" });
  return [first.id, second.id];
};

describeWithEnv("readRows", { db: true }, () => {
  test("returns every row that the read keeps", async () => {
    const [first, second] = await twoListingIds();

    expect(await readRows(listingIds([second, first]))).toEqual([
      { id: first },
      { id: second },
    ]);
  });

  test("returns no row when the read keeps none", async () => {
    await createTestListing({ name: "Other" });

    expect(await readRows(listingIds([-1]))).toEqual([]);
  });
});

describe("a read that no row can pass", () => {
  // No database exists here, so a round trip would throw.
  test("is answered with no rows and no round trip", async () => {
    expect(await readRows(listingIds([]))).toEqual([]);
  });

  test("is answered with null for one row", async () => {
    expect(await readOneRow(listingIds([]))).toBe(null);
  });
});

describeWithEnv("readOneRow", { db: true }, () => {
  test("returns the first row that the read keeps", async () => {
    const [first, second] = await twoListingIds();

    expect(await readOneRow(listingIds([first, second]))).toEqual({
      id: first,
    });
  });

  test("returns null when the read keeps no row", async () => {
    expect(await readOneRow(listingIds([-1]))).toBe(null);
  });
});
