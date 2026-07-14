// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#shared/db/groups.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

// jscpd:ignore-end

const recordListingsPage = async (names: string[]): Promise<string[]> => {
  await settings.update.showPublicSite(true);
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

const addGroupPageFixtures = async (
  kind: "group" | "package",
  start: number,
  count: number,
): Promise<string[]> => {
  const names = Array.from(
    { length: count },
    (_, offset) => `Query ${kind} ${start + offset}`,
  );
  for (const [offset, name] of names.entries()) {
    const group = await createTestGroup({
      isPackage: kind === "package",
      name,
      slug: `query-${kind}-${start + offset}`,
    });
    await createTestListing({
      groupId: group.id,
      name: `${kind} listing ${start + offset}`,
    });
  }
  return names;
};

const recordGroupPageQueries = async (
  kind: "group" | "package",
  start: number,
  count: number,
): Promise<string[]> => {
  const names = await addGroupPageFixtures(kind, start, count);
  return recordListingsPage(names);
};

describeWithEnv(
  "server public > listings query scaling",
  { db: true, triggers: true },
  () => {
    test("checks all regular groups with one batched classification", async () => {
      const first = await recordGroupPageQueries("group", 0, 1);
      const seen = await recordGroupPageQueries("group", 1, 3);

      const childLookups = seen.filter((sql) =>
        sql.startsWith(
          "SELECT DISTINCT child_listing_id AS id FROM listing_parents",
        ),
      );
      const batchedMembers = seen.filter((sql) =>
        sql.startsWith(
          "SELECT json_group_array(groupListing.group_id) AS group_ids,",
        ),
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
      expect(seen.length).toBe(first.length);
    });

    test("projects a shared listing once before mapping it to each group", async () => {
      const names = ["Shared group 1", "Shared group 2", "Shared group 3"];
      const groupIds: number[] = [];
      for (const [index, name] of names.entries()) {
        const group = await createTestGroup({
          name,
          slug: `shared-query-group-${index}`,
        });
        groupIds.push(group.id);
      }
      await createTestListing({
        groupIds,
        name: "One shared listing",
      });

      const seen = await recordListingsPage(names);
      const memberQuery = seen.find((sql) =>
        sql.startsWith(
          "SELECT json_group_array(groupListing.group_id) AS group_ids,",
        ),
      );
      expect(memberQuery).toContain("GROUP BY listing.id");
      expect(memberQuery).not.toContain("GROUP BY listing.id,");
      expect(memberQuery).toContain(
        "ORDER BY listing.created DESC, listing.id DESC",
      );
    });

    test("checks all packages with one shared set of package reads", async () => {
      const first = await recordGroupPageQueries("package", 0, 1);
      const seen = await recordGroupPageQueries("package", 1, 3);

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
      expect(seen.length).toBe(first.length);
    });
  },
);
