// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getBookableGroupIds } from "#routes/public/group-liveness.ts";
import { groups } from "#shared/db/groups.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testGroup } from "#test-utils/factories.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

// jscpd:ignore-end

const recordGroupPageQueries = async (
  kind: "group" | "package",
): Promise<string[]> => {
  await settings.update.showPublicSite(true);
  const names = ["First", "Second", "Third"].map(
    (position) => `${position} ${kind}`,
  );
  for (const [index, name] of names.entries()) {
    const group = await createTestGroup({
      isPackage: kind === "package",
      name,
      slug: `query-${kind}-${index}`,
    });
    await createTestListing({
      groupId: group.id,
      name: `${kind} listing ${index}`,
    });
  }

  groups.cache.invalidate();
  invalidateListingsCache();
  const seen: string[] = [];
  const restore = recordQueries(seen);
  try {
    await assertPublicHtml("/listings", ...names);
  } finally {
    restore();
  }
  return seen;
};

describeWithEnv(
  "server public > listings query scaling",
  { db: true, triggers: true },
  () => {
    test("checks all regular groups with one batched classification", async () => {
      const seen = await recordGroupPageQueries("group");

      const childLookups = seen.filter((sql) =>
        sql.startsWith(
          "SELECT DISTINCT child_listing_id AS id FROM listing_parents",
        ),
      );
      const batchedMembers = seen.filter((sql) =>
        sql.startsWith("SELECT groupListing.group_id, listing.*"),
      );
      const singleGroupMembers = seen.filter((sql) =>
        sql.includes(
          "listing.id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)",
        ),
      );

      // One classification decides regular-group liveness; the other decides
      // the individual listing cards. Adding groups must not add either query.
      expect(childLookups.length).toBe(2);
      expect(batchedMembers.length).toBe(1);
      expect(singleGroupMembers.length).toBe(0);
    });

    test("fails when a batched group has no member result", async () => {
      await expect(
        getBookableGroupIds([testGroup({ id: 42 })], new Map()),
      ).rejects.toThrow("Members missing for group 42");
    });

    test("checks all packages with one shared set of package reads", async () => {
      const seen = await recordGroupPageQueries("package");

      const packageRows = seen.filter((sql) =>
        sql.startsWith(
          "SELECT groupListing.group_id, groupListing.listing_id,",
        ),
      );
      const onePackageIds = seen.filter((sql) =>
        sql.startsWith(
          "SELECT listing_id AS id FROM group_listings WHERE group_id = ?",
        ),
      );
      expect(packageRows.length).toBe(1);
      expect(onePackageIds.length).toBe(0);
    });
  },
);
