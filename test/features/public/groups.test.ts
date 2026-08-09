/**
 * Public group loading: which slugs sell a whole package, and what a cart URL
 * costs to resolve. A cart may name a lot of packages, so resolving them must
 * cost the same handful of database calls whether the visitor asks for one or
 * ten — Bunny stops an edge request after 50 subrequests.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  handleGroupTicketBySlug,
  loadBookablePackageBySlug,
  loadCartPackagesBySlugs,
} from "#routes/public/groups.ts";
import { groups } from "#shared/db/groups.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import type { Group } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Enough headroom for the fixed reads, far below what one read per slug costs. */
const CART_CALL_LIMIT = 8;

/** A package group with `memberCount` bookable members. */
const packageWithMembers = async (
  name: string,
  memberCount: number,
): Promise<Group> => {
  const group = await createTestGroup({ isPackage: true, name });
  for (let index = 0; index < memberCount; index++) {
    await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: `${name} member ${index}`,
      unitPrice: 500,
    });
  }
  return group;
};

/** Build `count` complete packages and return their slugs. */
const packageSlugs = async (
  label: string,
  count: number,
): Promise<string[]> => {
  const slugs: string[] = [];
  for (let index = 0; index < count; index++) {
    const group = await packageWithMembers(`${label} package ${index}`, 1);
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

describeWithEnv("public package slug loading", { db: true }, () => {
  test("sells a package whose whole bundle still fits", async () => {
    const group = await packageWithMembers("Bookable bundle", 1);

    const loaded = await loadBookablePackageBySlug(group.slug);
    expect(loaded).not.toBeNull();
    expect(loaded?.group.id).toBe(group.id);
    expect(loaded?.listings).toHaveLength(1);
  });

  test("does not sell a plain group as a package", async () => {
    const group = await createTestGroup({ name: "Plain group" });
    await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Plain member",
    });

    expect(await loadBookablePackageBySlug(group.slug)).toBeNull();
  });

  test("does not sell a package with no members", async () => {
    const group = await packageWithMembers("Empty bundle", 0);

    expect(await loadBookablePackageBySlug(group.slug)).toBeNull();
  });

  test("still shows a plain group whose members cannot be booked", async () => {
    const group = await createTestGroup({ name: "Sold out group" });
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 0,
      name: "Sold out member",
    });
    expect(listing.max_attendees).toBe(0);

    const response = await handleGroupTicketBySlug(
      mockRequest(`/ticket/${group.slug}`),
      group.slug,
    );
    expect(response.status).toBe(200);
  });
});

describeWithEnv("cart package resolution", { db: true }, () => {
  test("resolves every package it was asked for", async () => {
    const slugs = await packageSlugs("Resolved", 3);

    const resolved = await loadCartPackagesBySlugs(slugs);
    expect(resolved.every((pkg) => pkg !== null)).toBe(true);
    expect(resolved.map((pkg) => pkg?.group.slug)).toEqual(slugs);
  });

  test("resolves a cart holding a single package", async () => {
    const slugs = await packageSlugs("Alone", 1);

    const resolved = await loadCartPackagesBySlugs(slugs);
    expect(resolved.map((pkg) => pkg?.group.slug)).toEqual(slugs);
  });

  test("drops a package whose member was deactivated", async () => {
    const group = await packageWithMembers("Broken bundle", 2);
    const [loaded] = await loadCartPackagesBySlugs([group.slug]);
    if (!loaded) throw new Error("The complete package did not resolve");
    const [firstMember] = loaded.listings;
    if (!firstMember) throw new Error("The package has no members to drop");
    await deactivateTestListing(firstMember.id);

    expect(await loadCartPackagesBySlugs([group.slug])).toEqual([null]);
  });

  test("drops a package with no members at all", async () => {
    const group = await packageWithMembers("Nothing to sell", 0);

    expect(await loadCartPackagesBySlugs([group.slug])).toEqual([null]);
  });

  test("costs the same reads for ten packages as for two", async () => {
    const two = await packageSlugs("Small", 2);
    const ten = await packageSlugs("Large", 10);

    expect(await coldCartCalls(ten)).toBe(await coldCartCalls(two));
  });

  test("costs one read when no slug names a package", async () => {
    const listing = await createTestListing({ name: "Not a package" });

    expect(await coldCartCalls([listing.slug, "unknown-slug"])).toBe(1);
  });
});
