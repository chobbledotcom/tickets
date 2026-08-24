/**
 * missingListingIds reads the database directly, so a stale isolate cache
 * cannot vouch for a listing another isolate deleted.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { missingListingIds } from "#db/attendees/capacity/checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > missingListingIds", { db: true }, () => {
  test("answers an empty list when every listing exists", async () => {
    const listing = await createTestListing();
    expect(await missingListingIds([listing.id])).toEqual([]);
  });

  test("names only the ids with no listing row, in input order", async () => {
    const listing = await createTestListing();
    expect(await missingListingIds([999_998, listing.id, 999_999])).toEqual([
      999_998, 999_999,
    ]);
  });
});
