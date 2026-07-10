import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { computeSlugIndex, listingsTable } from "#shared/db/listings.ts";
import {
  isNameTakenAnywhere,
  loadCatalogNameIndex,
  matchName,
  normalizeEntityName,
} from "#shared/db/name-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("name-registry", { db: true }, () => {
  test("normalizeEntityName trims and case-folds", () => {
    expect(normalizeEntityName("  Weekend Pass  ")).toBe("weekend pass");
    expect(normalizeEntityName("WEEKEND pass")).toBe("weekend pass");
  });

  test("a name is free on an empty catalog", async () => {
    expect(await isNameTakenAnywhere("Anything")).toBe(false);
  });

  test("a listing name is taken by that listing", async () => {
    await createTestListing({ name: "Solo Show" });
    expect(await isNameTakenAnywhere("Solo Show")).toBe(true);
    // Case- and whitespace-insensitive, so an import can't smuggle a near-dup.
    expect(await isNameTakenAnywhere("  solo show ")).toBe(true);
  });

  test("a listing name collides with a group of the same name", async () => {
    await createTestGroup({ name: "Shared Name" });
    // A LISTING may not take a GROUP's name — the two share one namespace.
    expect(await isNameTakenAnywhere("Shared Name")).toBe(true);
  });

  test("a group name collides with a listing of the same name", async () => {
    await createTestListing({ name: "Overlap" });
    expect(
      await isNameTakenAnywhere("Overlap", { id: 99999, kind: "group" }),
    ).toBe(true);
  });

  test("excluding the owning row lets it keep its own name", async () => {
    const listing = await createTestListing({ name: "Keep Me" });
    expect(
      await isNameTakenAnywhere("Keep Me", { id: listing.id, kind: "listing" }),
    ).toBe(false);
    // Excluding the wrong kind/id does not free the name.
    expect(
      await isNameTakenAnywhere("Keep Me", { id: listing.id, kind: "group" }),
    ).toBe(true);
  });

  test("a blank or whitespace-only name is never taken", async () => {
    expect(await isNameTakenAnywhere("")).toBe(false);
    expect(await isNameTakenAnywhere("   ")).toBe(false);
  });

  test("matchName resolves a unique listing and group by name", async () => {
    const listing = await createTestListing({ name: "Findable" });
    const group = await createTestGroup({ name: "Group One" });
    const index = await loadCatalogNameIndex();
    expect(matchName(index.listing, "findable")).toEqual({
      id: listing.id,
      ok: true,
    });
    expect(matchName(index.group, "  Group One ")).toEqual({
      id: group.id,
      ok: true,
    });
  });

  test("an unnamed legacy row is dropped from the index", async () => {
    // A whitespace-only name (legacy data predating the required-name rule)
    // must not occupy the empty-string key — it never participates in
    // uniqueness or name lookup.
    const slug = "blank-name";
    await listingsTable.insert({
      maxAttendees: 1,
      maxPrice: 0,
      name: "   ",
      slug,
      slugIndex: await computeSlugIndex(slug),
    });
    const real = await createTestListing({ name: "Named One" });
    const index = await loadCatalogNameIndex();
    expect(index.listing.has("")).toBe(false);
    expect(matchName(index.listing, "Named One")).toEqual({
      id: real.id,
      ok: true,
    });
  });

  test("matchName reports a missing name", async () => {
    const index = await loadCatalogNameIndex();
    expect(matchName(index.listing, "Ghost")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("matchName reports an ambiguous legacy duplicate", async () => {
    // Insert straight through the table (bypassing the uniqueness validator) to
    // simulate legacy data that predates the rule: two listings, one name.
    const slugA = "dup-a";
    const slugB = "dup-b";
    await listingsTable.insert({
      maxAttendees: 1,
      maxPrice: 0,
      name: "Twin",
      slug: slugA,
      slugIndex: await computeSlugIndex(slugA),
    });
    await listingsTable.insert({
      maxAttendees: 1,
      maxPrice: 0,
      name: "Twin",
      slug: slugB,
      slugIndex: await computeSlugIndex(slugB),
    });
    const index = await loadCatalogNameIndex();
    expect(matchName(index.listing, "Twin")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
    // And the ambiguous name reads as taken for uniqueness purposes.
    expect(await isNameTakenAnywhere("Twin")).toBe(true);
  });
});
