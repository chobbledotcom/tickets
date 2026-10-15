import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { says } from "#test-utils/says.ts";

describeWithEnv("catalog-transfer branch coverage", { db: true }, () => {
  test("rejects an ambiguous (duplicate-named) reference", async () => {
    const { listingsTable } = await import("#db/listings/records.ts");
    const { hmacHash } = await import("#crypto/hashing.ts");
    for (const slug of ["twin-a", "twin-b"]) {
      await listingsTable.insert({
        maxAttendees: 1,
        maxPrice: 0,
        name: "Twin Parent",
        slug,
        slugIndex: await hmacHash(slug),
      });
    }
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Ambiguous Child" },
      parents: ["Twin Parent"],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    says(result.error, "names must be unique to import");
  });

  test("surfaces a listing-validation error (group type mismatch)", async () => {
    const group = await createTestGroup({ name: "Std Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "standard",
      name: "Std Member",
    });
    const result = await importCatalog({
      groups: [{ group: "Std Group" }],
      kind: "listing",
      listing: { listingType: "daily", maxAttendees: 5, name: "Daily Joiner" },
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    says(result.error, "same type");
  });

  test("rejects a group name already in use", async () => {
    await createTestGroup({ name: "Taken Group" });
    const result = await importCatalog({
      group: { name: "Taken Group" },
      kind: "group",
      members: [],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    says(result.error, "already exists");
  });

  test("rejects group members that disagree on customisable days", async () => {
    await createTestListing({ listingType: "standard", name: "Fixed Days" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      durationDays: 1,
      listingType: "standard",
      name: "Flexible Days",
    });
    const result = await importCatalog({
      group: { name: "Mixed Days" },
      kind: "group",
      members: [{ listing: "Fixed Days" }, { listing: "Flexible Days" }],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    says(result.error, "customisable days");
  });

  test("rejects a package group with a non-packageable member", async () => {
    await createTestListing({
      canPayMore: true,
      maxPrice: 5000,
      name: "Pay What You Want",
      unitPrice: 1000,
    });
    const result = await importCatalog({
      group: { isPackage: true, name: "Bad Package" },
      kind: "group",
      members: [{ listing: "Pay What You Want" }],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    says(result.error, "Packages cannot contain");
  });
});
