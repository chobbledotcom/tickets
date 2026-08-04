/**
 * A cart URL can name a lot of packages. Resolving them must cost the same
 * handful of database calls whether the visitor asks for two or ten, because
 * Bunny stops an edge request after 50 subrequests.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadCartPackagesBySlugs } from "#routes/public/groups.ts";
import { groups } from "#shared/db/groups.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Enough headroom for the fixed reads, far below what one read per slug costs. */
const CART_CALL_LIMIT = 8;

/** Build `count` complete packages and return their slugs. */
const packageSlugs = async (
  label: string,
  count: number,
): Promise<string[]> => {
  const slugs: string[] = [];
  for (let index = 0; index < count; index++) {
    const group = await createTestGroup({
      isPackage: true,
      name: `${label} package ${index}`,
    });
    await createTestListing({
      groupId: group.id,
      name: `${label} member ${index}`,
      unitPrice: 500,
    });
    slugs.push(group.slug);
  }
  return slugs;
};

/** Resolve the slugs from cold caches, under a hard database-call allowance. */
const coldCartCalls = (slugs: string[]): Promise<number> => {
  groups.cache.invalidate();
  invalidateListingsCache();
  return countDatabaseCalls(CART_CALL_LIMIT, () =>
    loadCartPackagesBySlugs(slugs),
  );
};

describeWithEnv("cart package resolution budget", { db: true }, () => {
  test("costs the same reads for ten packages as for two", async () => {
    const two = await packageSlugs("Small", 2);
    const ten = await packageSlugs("Large", 10);

    expect(await coldCartCalls(ten)).toBe(await coldCartCalls(two));
  });

  test("resolves every package it was asked for", async () => {
    const slugs = await packageSlugs("Resolved", 3);

    const resolved = await loadCartPackagesBySlugs(slugs);
    expect(resolved.map((pkg) => pkg?.group.slug)).toEqual(slugs);
  });

  test("costs no reads at all when no slug names a package", async () => {
    const listing = await createTestListing({ name: "Not a package" });

    expect(await coldCartCalls([listing.slug, "unknown-slug"])).toBe(1);
  });
});
