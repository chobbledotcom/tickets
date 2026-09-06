// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import {
  getVisibleGroupMembers,
  loadBookableGroupIds,
} from "#routes/public/group-liveness.ts";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

const recordPublicPage = async (
  path: string,
  names: string[],
): Promise<string[]> => {
  await enablePublicSite();
  groups.cache.invalidate();
  invalidateListingsCache();
  const seen: string[] = [];
  const restore = recordQueries(seen);
  try {
    await assertPublicHtml(path, ...names);
  } finally {
    restore();
  }
  return seen;
};

const recordListingsPage = (names: string[]): Promise<string[]> =>
  recordPublicPage("/listings", names);

const batchedMemberQueries = (seen: readonly string[]): string[] =>
  seen.filter((sql) =>
    sql.startsWith(
      "SELECT json_group_array(groupListing.group_id) AS group_ids,",
    ),
  );

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
  "public group query scaling",
  { db: true, triggers: true },
  () => {
    test("checks all regular groups with one batched classification", async () => {
      const firstNames = await addGroupPageFixtures("group", 0, 1);
      await recordListingsPage(firstNames);
      const first = await recordListingsPage(firstNames);
      const seen = await recordGroupPageQueries("group", 1, 3);

      const edgeReads = seen.filter((sql) =>
        sql.startsWith(
          "SELECT parent_listing_id AS key_id, child_listing_id AS value_id",
        ),
      );
      const reverseEdgeReads = seen.filter((sql) =>
        sql.startsWith("SELECT child_listing_id AS key_id"),
      );
      const batchedMembers = batchedMemberQueries(seen);
      const singleGroupMembers = seen.filter((sql) =>
        sql.includes(
          "listing.id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)",
        ),
      );

      // One classification decides regular-group liveness; the other decides
      // the individual listing cards. Adding groups must not add either query.
      // Both classifications ask about the same listings, and one read answers
      // a listing's children and its parents together, so the whole page reads
      // the edge table once and never separately for the other direction.
      expect(edgeReads.length).toBe(1);
      expect(reverseEdgeReads).toEqual([]);
      expect(batchedMembers.length).toBe(1);
      expect(singleGroupMembers.length).toBe(0);
      expect(seen.length).toBe(first.length);
    });

    test("loads one group's members through the grouped query", async () => {
      const group = await createTestGroup({
        name: "One grouped query",
        slug: "one-grouped-query",
      });
      const listing = await createTestListing({
        groupId: group.id,
        name: "One grouped listing",
      });
      const seen: string[] = [];
      const restore = recordQueries(seen);
      let memberIds: number[] = [];
      try {
        memberIds = (await getVisibleGroupMembers(group)).map(
          (member) => member.id,
        );
      } finally {
        restore();
      }

      expect(memberIds).toEqual([listing.id]);
      expect(batchedMemberQueries(seen).length).toBe(1);
      expect(
        seen.filter((sql) =>
          sql.includes(
            "listing.id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)",
          ),
        ).length,
      ).toBe(0);
    });

    test("reuses package members on the order page", async () => {
      await settings.update.orderEnabled(true);
      const names = await addGroupPageFixtures("package", 20, 1);
      const seen = await recordPublicPage("/order", names);

      expect(batchedMemberQueries(seen).length).toBe(1);
    });

    test("reuses package members for a date-filtered listings page", async () => {
      const names = await addGroupPageFixtures("package", 30, 1);
      const seen = await recordPublicPage("/listings?date=2030-01-01", names);

      expect(batchedMemberQueries(seen).length).toBe(1);
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
      const memberQueries = batchedMemberQueries(seen);
      expect(memberQueries.length).toBe(1);
      const [memberQuery] = memberQueries;
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

describeWithEnv("public regular group liveness", { db: true }, () => {
  test("a visible group stays live when its listing is hidden", async () => {
    const group = await createTestGroup({ name: "Visible group" });
    await createTestListing({
      groupId: group.id,
      hidden: true,
      name: "Hidden listing",
    });

    expect(await loadBookableGroupIds([group])).toEqual(new Set([group.id]));
  });

  test("a group with only an inactive listing has no booking page", async () => {
    const group = await createTestGroup({ name: "Inactive group" });
    const listing = await createTestListing({
      groupId: group.id,
      name: "Inactive listing",
    });
    await deactivateTestListing(listing.id);

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });

  test("a group with only an add-on has no public booking page", async () => {
    const group = await createTestGroup({ name: "Add-on group" });
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({
      groupId: group.id,
      name: "Add-on",
    });
    await listingChildren.setIds(parent.id, [child.id]);

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });

  test("a group with only a sold-out parent has no booking page", async () => {
    const group = await createTestGroup({ name: "Parent group" });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Parent",
    });
    const child = await createTestListing({
      maxAttendees: 1,
      name: "Full add-on",
    });
    await createTestAttendee(
      child.id,
      child.slug,
      "Buyer",
      "buyer@example.com",
    );
    await listingChildren.setIds(parent.id, [child.id]);

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });
});

describeWithEnv("public package liveness", { db: true }, () => {
  test("an empty package has no booking page", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Empty package",
    });

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });

  test("a package with an inactive member has no booking page", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Incomplete package",
    });
    await createTestListing({ groupId: group.id, name: "Active member" });
    const inactive = await createTestListing({
      groupId: group.id,
      name: "Inactive member",
    });
    await deactivateTestListing(inactive.id);

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });

  test("a package with no remaining capacity has no booking page", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Full package",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 1,
      name: "Full member",
    });
    await createTestAttendee(
      member.id,
      member.slug,
      "Buyer",
      "full@example.com",
    );

    expect(await loadBookableGroupIds([group])).toEqual(new Set());
  });
});
