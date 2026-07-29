import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#shared/db/client.ts";
import {
  getGroupPackagePrices,
  listingGroups,
  setGroupPackageMembers,
  setListingGroups,
} from "#shared/db/groups.ts";
import { loadMigrations } from "#shared/db/migrations/context.ts";

import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const MIGRATIONS = await loadMigrations();
const sortNums = (ns: number[]): number[] => ns.toSorted((a, b) => a - b);

/** A package group with two member listings assigned to it (each test then sets
 * its own package overrides). `slug` keys the group and the listing names. */
const groupWithTwoMembers = async (slug: string) => {
  const group = await createTestGroup({ name: slug, slug });
  const a = await createTestListing({ name: `${slug}-a` });
  const b = await createTestListing({ name: `${slug}-b` });
  await setListingGroups(a.id, [group.id]);
  await setListingGroups(b.id, [group.id]);
  return { a, b, group };
};

describeWithEnv("db > group_listings membership", { db: true }, () => {
  test("listingGroups returns every group a listing belongs to", async () => {
    const g1 = await createTestGroup({ name: "G1", slug: "g1" });
    const g2 = await createTestGroup({ name: "G2", slug: "g2" });
    const listing = await createTestListing({ name: "Multi" });
    await setListingGroups(listing.id, [g1.id, g2.id]);

    const map = await listingGroups.getIdsByKeys([listing.id]);
    expect(sortNums(map.get(listing.id) ?? [])).toEqual(
      sortNums([g1.id, g2.id]),
    );
  });

  test("getGroupPackagePrices returns every membership row with its override", async () => {
    const { group, a, b } = await groupWithTwoMembers("pkg");

    await setGroupPackageMembers(group.id, [
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

  test("stores the flat override in listing_prices' group dimension, not on group_listings", async () => {
    const { group, a } = await groupWithTwoMembers("storage");
    await setGroupPackageMembers(group.id, [{ listingId: a.id, price: 1500 }]);
    // The override is a ("group", "<groupId>") row keyed to the member listing —
    // the source of truth since group_listings.package_price was retired.
    expect(
      await queryAll(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'group' AND price_id = ?",
        [a.id, String(group.id)],
      ),
    ).toEqual([{ unit_price: 1500 }]);
    // Clearing the overrides removes the row (so getGroupPackagePrices reads null).
    await setGroupPackageMembers(group.id, []);
    expect(
      await queryAll(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'group'",
        [a.id],
      ),
    ).toEqual([]);
    expect((await getGroupPackagePrices(group.id))[0]!.package_price).toBe(
      null,
    );
  });

  test("leaving a package group clears the listing's override row (no resurrection on re-add)", async () => {
    const { group, a } = await groupWithTwoMembers("leave");
    await setGroupPackageMembers(group.id, [{ listingId: a.id, price: 1500 }]);
    const overrideRows = () =>
      queryAll(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'group' AND price_id = ?",
        [a.id, String(group.id)],
      );
    expect((await overrideRows()).length).toBe(1);

    // Untick the listing from the group: its override row must go with the
    // membership, not survive it.
    await setListingGroups(a.id, []);
    expect(await overrideRows()).toEqual([]);

    // Re-adding starts from no override, exactly like the old package_price
    // column did when the membership row was deleted.
    await setListingGroups(a.id, [group.id]);
    const readded = await getGroupPackagePrices(group.id);
    expect(
      readded.find((r) => r.listing_id === a.id)?.package_price ?? null,
    ).toBe(null);
  });

  test("collapses duplicate member entries (last wins) without a unique-constraint abort", async () => {
    const { group, a } = await groupWithTwoMembers("dup");
    // The JSON API accepts an array, so a client can send the same listing_id
    // twice — this must not abort on the unique listing_prices index; the last
    // entry wins (matching the retired CASE-update behaviour).
    await setGroupPackageMembers(group.id, [
      { listingId: a.id, price: 100, quantity: 2 },
      { listingId: a.id, price: 900, quantity: 5 },
    ]);
    const rows = await getGroupPackagePrices(group.id);
    const member = rows.find((r) => r.listing_id === a.id)!;
    expect(member.package_price).toBe(900);
    expect(member.quantity).toBe(5);
  });

  test("setGroupPackageMembers stores per-package quantities (default 1)", async () => {
    const { group, a, b } = await groupWithTwoMembers("qty");

    // A names quantity 3; B omits it and falls back to 1.
    await setGroupPackageMembers(group.id, [
      { listingId: a.id, price: 100, quantity: 3 },
      { listingId: b.id, price: 200 },
    ]);
    const rows = await getGroupPackagePrices(group.id);
    const byId = new Map(rows.map((r) => [r.listing_id, r.quantity]));
    expect(byId.get(a.id)).toBe(3);
    expect(byId.get(b.id)).toBe(1);

    // Clearing resets quantity back to 1 as well as price to NULL (no override).
    await setGroupPackageMembers(group.id, []);
    const cleared = await getGroupPackagePrices(group.id);
    expect(
      cleared.every((r) => r.quantity === 1 && r.package_price === null),
    ).toBe(true);
  });

  test("getTestPackagePrices keeps an explicit-free override but skips no-override members", async () => {
    const { group, a, b } = await groupWithTwoMembers("map");
    // a: a positive override; b: an explicit free price (0) — a real value that
    // is kept, distinct from a `null` no-override member which is skipped.
    await setGroupPackageMembers(group.id, [
      { listingId: a.id, price: 999 },
      { listingId: b.id, price: 0 },
    ]);

    const map = await getTestPackagePrices(group.id);
    expect(map.get(a.id)).toBe(999);
    expect(map.get(b.id)).toBe(0);

    // Re-submitting b with no override (null) drops it from the map.
    await setGroupPackageMembers(group.id, [
      { listingId: a.id, price: 999 },
      { listingId: b.id, price: null },
    ]);
    const after = await getTestPackagePrices(group.id);
    expect(after.get(a.id)).toBe(999);
    expect(after.has(b.id)).toBe(false);
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
    expect(await listingGroups.getIds(listing.id)).toEqual([77]);
    const columns = await queryAll<{ name: string }>(
      "PRAGMA table_info(listings)",
    );
    expect(columns.some((c) => c.name === "group_id")).toBe(false);

    // Re-running is a no-op (idempotency guard: the column is already gone).
    await migration.up();
    expect(await listingGroups.getIds(listing.id)).toEqual([77]);
  });
});
