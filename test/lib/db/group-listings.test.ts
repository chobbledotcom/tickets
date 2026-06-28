import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#shared/db/client.ts";
import {
  getGroupIdsByListingId,
  getGroupIdsByListingIds,
  getGroupPackagePrices,
  setGroupPackagePrices,
  setListingGroups,
} from "#shared/db/groups.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  getTestPackagePrices,
} from "#test-utils";

const sortNums = (ns: number[]): number[] => ns.toSorted((a, b) => a - b);

describeWithEnv("db > group_listings membership", { db: true }, () => {
  test("getGroupIdsByListingIds returns every group a listing belongs to", async () => {
    const g1 = await createTestGroup({ name: "G1", slug: "g1" });
    const g2 = await createTestGroup({ name: "G2", slug: "g2" });
    const listing = await createTestListing({ name: "Multi" });
    await setListingGroups(listing.id, [g1.id, g2.id]);

    const map = await getGroupIdsByListingIds([listing.id]);
    expect(sortNums(map.get(listing.id) ?? [])).toEqual(
      sortNums([g1.id, g2.id]),
    );
  });

  test("setListingGroups removes unticked, adds new, keeps retained groups", async () => {
    const g1 = await createTestGroup({ name: "A", slug: "a" });
    const g2 = await createTestGroup({ name: "B", slug: "b" });
    const g3 = await createTestGroup({ name: "C", slug: "c" });
    const listing = await createTestListing({ name: "Diff" });

    await setListingGroups(listing.id, [g1.id, g2.id]);
    // Keep g2, drop g1, add g3.
    await setListingGroups(listing.id, [g2.id, g3.id]);
    expect(sortNums(await getGroupIdsByListingId(listing.id))).toEqual(
      sortNums([g2.id, g3.id]),
    );

    // Setting the same set again is a no-op (no statements to run).
    await setListingGroups(listing.id, [g2.id, g3.id]);
    expect(sortNums(await getGroupIdsByListingId(listing.id))).toEqual(
      sortNums([g2.id, g3.id]),
    );
  });

  test("getGroupPackagePrices returns every membership row with its override", async () => {
    const group = await createTestGroup({ name: "Pkg", slug: "pkg" });
    const a = await createTestListing({ name: "A" });
    const b = await createTestListing({ name: "B" });
    await setListingGroups(a.id, [group.id]);
    await setListingGroups(b.id, [group.id]);

    await setGroupPackagePrices(group.id, [
      { listingId: a.id, price: 1500 },
      { listingId: b.id, price: 0 },
    ]);

    const rows = await getGroupPackagePrices(group.id);
    expect(rows.map((r) => [r.listing_id, r.package_price]).sort()).toEqual(
      [
        [a.id, 1500],
        [b.id, 0],
      ].sort(),
    );
  });

  test("getTestPackagePrices maps only the listings with a non-zero override", async () => {
    const group = await createTestGroup({ name: "Map", slug: "map" });
    const a = await createTestListing({ name: "MA" });
    const b = await createTestListing({ name: "MB" });
    await setListingGroups(a.id, [group.id]);
    await setListingGroups(b.id, [group.id]);
    await setGroupPackagePrices(group.id, [
      { listingId: a.id, price: 999 },
      { listingId: b.id, price: 0 },
    ]);

    const map = await getTestPackagePrices(group.id);
    expect(map.get(a.id)).toBe(999);
    expect(map.has(b.id)).toBe(false);
  });

  test("setGroupPackagePrices zeroes members it isn't given and clears on empty", async () => {
    const group = await createTestGroup({ name: "Clr", slug: "clr" });
    const a = await createTestListing({ name: "CA" });
    const b = await createTestListing({ name: "CB" });
    await setListingGroups(a.id, [group.id]);
    await setListingGroups(b.id, [group.id]);

    // Only A named: B falls into the CASE's ELSE branch and is reset to 0.
    await setGroupPackagePrices(group.id, [{ listingId: a.id, price: 700 }]);
    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[a.id, 700]]),
    );

    // Empty array clears every override.
    await setGroupPackagePrices(group.id, []);
    expect(await getTestPackagePrices(group.id)).toEqual(new Map());
  });

  test("the migration backfills group_listings from a legacy group_id column", async () => {
    // Reconstruct a pre-migration shape: re-add the dropped column with data, so
    // the migration's up() exercises its backfill + column-drop path.
    await execute(
      "ALTER TABLE listings ADD COLUMN group_id INTEGER NOT NULL DEFAULT 0",
    );
    const listing = await createTestListing({ name: "Legacy" });
    await execute("UPDATE listings SET group_id = ? WHERE id = ?", [
      77,
      listing.id,
    ]);

    const migration = MIGRATIONS.find(
      (m) => m.id === "2026-06-28_group_listings",
    )!;
    await migration.up();

    // The legacy value is migrated into group_listings and the column is gone.
    expect(await getGroupIdsByListingId(listing.id)).toEqual([77]);
    const columns = await queryAll<{ name: string }>(
      "PRAGMA table_info(listings)",
    );
    expect(columns.some((c) => c.name === "group_id")).toBe(false);

    // Re-running is a no-op (idempotency guard: the column is already gone).
    await migration.up();
    expect(await getGroupIdsByListingId(listing.id)).toEqual([77]);
  });
});
