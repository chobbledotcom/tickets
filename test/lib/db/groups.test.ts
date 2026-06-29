import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  getGroupRemainingByGroupId,
  getGroupRemainingByListingId,
  getGroupRemainingForListing,
  hasAvailableSpots,
} from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  anyListingInPackageGroup,
  assignListingsToGroup,
  computeGroupSlugIndex,
  getActiveListingsByGroupId,
  getAllGroups,
  getGroupBySlugIndex,
  getGroupIdsByListingId,
  getPackageDisplayForListings,
  groupsTable,
  isGroupSlugTaken,
  resetGroupListings,
} from "#shared/db/groups.ts";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import {
  bookAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > groups", { db: true, triggers: true }, () => {
  /** Create a capped group with two listings (each with listing-level max of 10). */
  const createCappedGroupWithListings = async (
    groupMax: number,
    slug: string,
    overrides?: { listingType?: "standard" | "daily" },
  ) => {
    const group = await createTestGroup({
      maxAttendees: groupMax,
      name: slug,
      slug,
    });
    const e1 = await createTestListing({
      groupId: group.id,
      listingType: overrides?.listingType,
      maxAttendees: 10,
      name: `${slug}-a`,
    });
    const e2 = await createTestListing({
      groupId: group.id,
      listingType: overrides?.listingType,
      maxAttendees: 10,
      name: `${slug}-b`,
    });
    return { e1, e2, group };
  };

  /** Book attendees atomically with minimal boilerplate. The generated
   *  email/name is keyed by `listingId`+`quantity` so distinct bookings
   *  within a test never collide. */
  const book = (listingId: number, quantity: number, date?: string) =>
    createAttendeeAtomic({
      bookings: [{ date, listingId, quantity }],
      email: `g${listingId}q${quantity}@example.com`,
      name: `g-${listingId}-${quantity}`,
    });

  describe("CRUD", () => {
    test("groupsTable create, update, findById, deleteById", async () => {
      const created = await createTestGroup({
        name: "DB Group",
        slug: "db-group",
      });

      const fetched = await groupsTable.findById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("DB Group");
      expect(fetched?.slug).toBe("db-group");

      const updated = await groupsTable.update(created.id, {
        name: "DB Group Updated",
        termsAndConditions: "Terms",
      });
      expect(updated?.name).toBe("DB Group Updated");
      expect(updated?.terms_and_conditions).toBe("Terms");

      await groupsTable.deleteById(created.id);
      expect(await groupsTable.findById(created.id)).toBeNull();
    });

    test("getAllGroups returns decrypted groups ordered by id", async () => {
      const g1 = await createTestGroup({ name: "Group A", slug: "group-a" });
      const g2 = await createTestGroup({ name: "Group B", slug: "group-b" });
      const groups = await getAllGroups();
      expect(groups.length).toBe(2);
      expect(groups[0]?.id).toBe(g1.id);
      expect(groups[1]?.id).toBe(g2.id);
      expect(groups[0]?.name).toBe("Group A");
      expect(groups[1]?.name).toBe("Group B");
    });

    test("getGroupBySlugIndex returns group or null", async () => {
      const group = await createTestGroup({
        name: "Index Group",
        slug: "idx-group",
      });

      const found = await getGroupBySlugIndex(
        await computeGroupSlugIndex("idx-group"),
      );
      expect(found?.slug).toBe(group.slug);
      expect(await getGroupBySlugIndex("missing")).toBeNull();
    });

    test("isGroupSlugTaken checks both groups and listings", async () => {
      const groupSlug = "taken-by-group";
      const created = await createTestGroup({
        name: "Taken",
        slug: groupSlug,
      });

      expect(await isGroupSlugTaken(groupSlug)).toBe(true);
      expect(await isGroupSlugTaken(groupSlug, created.id)).toBe(false);

      const listing = await createTestListing({ name: "Taken Listing" });
      expect(await isGroupSlugTaken(listing.slug)).toBe(true);
    });

    test("getActiveListingsByGroupId returns active listings with attendee counts", async () => {
      const group = await createTestGroup({
        name: "Listings Group",
        slug: "listings-group",
      });

      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Active In Group",
      });
      const e2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Inactive In Group",
      });
      await getDb().execute({
        args: [e2.id],
        sql: "UPDATE listings SET active = 0 WHERE id = ?",
      });

      const attendee = await bookAttendee(e1, {
        email: "a@example.com",
        name: "A",
        quantity: 3,
      });
      if (!attendee.success) throw new Error("Failed to create attendee");

      const listings = await getActiveListingsByGroupId(group.id);
      expect(listings.length).toBe(1);
      expect(listings[0]?.id).toBe(e1.id);
      expect(listings[0]?.attendee_count).toBe(3);
    });

    test("resetGroupListings removes every membership row", async () => {
      const group = await createTestGroup({
        name: "Reset Group",
        slug: "reset-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Reset Listing",
      });
      await resetGroupListings(group.id);
      expect(await getGroupIdsByListingId(listing.id)).toEqual([]);
    });

    test("assignListingsToGroup moves every listing in one batch", async () => {
      const group = await createTestGroup({
        name: "Assign Group",
        slug: "assign-group",
      });
      const a = await createTestListing({ maxAttendees: 10, name: "Assign A" });
      const b = await createTestListing({ maxAttendees: 10, name: "Assign B" });
      expect(await getGroupIdsByListingId(a.id)).toEqual([]);
      expect(await getGroupIdsByListingId(b.id)).toEqual([]);

      await assignListingsToGroup([a.id, b.id], group.id);

      expect(await getGroupIdsByListingId(a.id)).toContain(group.id);
      expect(await getGroupIdsByListingId(b.id)).toContain(group.id);
    });

    test("assignListingsToGroup is a no-op for an empty list", async () => {
      const group = await createTestGroup({
        name: "Empty Assign",
        slug: "empty-assign",
      });
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Untouched",
      });

      await assignListingsToGroup([], group.id);

      expect(await getGroupIdsByListingId(listing.id)).toEqual([]);
    });
  });

  describe("capacity", () => {
    test("createAttendeeAtomic enforces group max_attendees across listings", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(5, "capped");

      expect((await book(e1.id, 3)).success).toBe(true);

      const r2 = await book(e2.id, 3);
      expect(r2.success).toBe(false);
      if (!r2.success) expect(r2.reason).toBe("capacity_exceeded");

      expect((await book(e2.id, 2)).success).toBe(true);
    });

    test("createAttendeeAtomic allows booking when group has no max (0)", async () => {
      const group = await createTestGroup({
        name: "unlimited",
        slug: "unlimited",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        name: "unlimited-listing",
      });

      expect((await book(listing.id, 50)).success).toBe(true);
    });

    test("hasAvailableSpots checks group capacity", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(3, "spots");

      await book(e1.id, 2);

      expect(await hasAvailableSpots(e2.id, 1)).toBe(true);
      expect(await hasAvailableSpots(e2.id, 2)).toBe(false);
    });

    test("checkBatchAvailability checks group capacity", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(4, "batch");

      expect(
        await checkBatchAvailability([
          { listingId: e1.id, quantity: 3 },
          { listingId: e2.id, quantity: 2 },
        ]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([
          { listingId: e1.id, quantity: 2 },
          { listingId: e2.id, quantity: 2 },
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability skips group check when group has no limit", async () => {
      const group = await createTestGroup({
        name: "no-limit",
        slug: "no-limit",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        name: "no-limit-a",
      });
      const ungrouped = await createTestListing({
        maxAttendees: 100,
        name: "ungrouped",
      });

      expect(
        await checkBatchAvailability([
          { listingId: e1.id, quantity: 50 },
          { listingId: ungrouped.id, quantity: 50 },
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability handles listings from multiple groups", async () => {
      const { e1: eA } = await createCappedGroupWithListings(3, "multi-a");
      const { e1: eB } = await createCappedGroupWithListings(3, "multi-b");

      expect(
        await checkBatchAvailability([
          { listingId: eA.id, quantity: 2 },
          { listingId: eB.id, quantity: 2 },
        ]),
      ).toBe(true);
    });

    test("capacity check handles deleted group gracefully", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "delete-me",
        slug: "delete-me",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "orphan-listing",
      });
      await groupsTable.deleteById(group.id);

      expect(await hasAvailableSpots(listing.id, 1)).toBe(true);
    });

    test("max_attendees is per-date for daily listings", async () => {
      const { e1: listing } = await createCappedGroupWithListings(3, "daily", {
        listingType: "daily",
      });

      expect((await book(listing.id, 3, "2026-07-01")).success).toBe(true);
      expect((await book(listing.id, 1, "2026-07-01")).success).toBe(false);
      expect((await book(listing.id, 3, "2026-07-02")).success).toBe(true);
    });

    test("daily group cap counts across multiple listings for same date", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(4, "daily-multi", {
        listingType: "daily",
      });

      expect((await book(e1.id, 2, "2026-07-01")).success).toBe(true);
      expect((await book(e2.id, 2, "2026-07-01")).success).toBe(true);
      expect((await book(e2.id, 1, "2026-07-01")).success).toBe(false);
      expect((await book(e2.id, 3, "2026-07-02")).success).toBe(true);
    });

    test("hasAvailableSpots checks group capacity for daily listings with date", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(3, "daily-spots", {
        listingType: "daily",
      });

      await book(e1.id, 2, "2026-08-01");

      expect(await hasAvailableSpots(e2.id, 1, "2026-08-01")).toBe(true);
      expect(await hasAvailableSpots(e2.id, 2, "2026-08-01")).toBe(false);
      expect(await hasAvailableSpots(e2.id, 3, "2026-08-02")).toBe(true);
    });

    test("checkBatchAvailability checks group capacity with date for daily listings", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(5, "daily-batch", {
        listingType: "daily",
      });

      expect(
        await checkBatchAvailability(
          [
            { listingId: e1.id, quantity: 3 },
            { listingId: e2.id, quantity: 3 },
          ],
          "2026-09-01",
        ),
      ).toBe(false);

      expect(
        await checkBatchAvailability(
          [
            { listingId: e1.id, quantity: 2 },
            { listingId: e2.id, quantity: 3 },
          ],
          "2026-09-01",
        ),
      ).toBe(true);
    });

    test("checkBatchAvailability considers pre-existing attendees in group", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(5, "pre-exist");

      await book(e1.id, 3);

      expect(
        await checkBatchAvailability([{ listingId: e2.id, quantity: 3 }]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([{ listingId: e2.id, quantity: 2 }]),
      ).toBe(true);
    });

    test("listing-level cap rejects even when group has room", async () => {
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "big-group",
        slug: "big-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 2,
        name: "small-listing",
      });

      expect((await book(listing.id, 2)).success).toBe(true);
      const r = await book(listing.id, 1);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.reason).toBe("capacity_exceeded");
    });

    test("hasAvailableSpots respects listing cap even when group has room", async () => {
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "big-group2",
        slug: "big-group2",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 1,
        name: "tiny-listing",
      });

      await book(listing.id, 1);
      expect(await hasAvailableSpots(listing.id, 1)).toBe(false);
    });

    test("checkBatchAvailability rejects when one group is full and another has room", async () => {
      const { e1: fullGroupListing } = await createCappedGroupWithListings(
        2,
        "full-grp",
      );
      const { e1: openGroupListing } = await createCappedGroupWithListings(
        10,
        "open-grp",
      );

      await book(fullGroupListing.id, 2);

      expect(
        await checkBatchAvailability([
          { listingId: fullGroupListing.id, quantity: 1 },
          { listingId: openGroupListing.id, quantity: 1 },
        ]),
      ).toBe(false);

      expect(
        await checkBatchAvailability([
          { listingId: openGroupListing.id, quantity: 1 },
        ]),
      ).toBe(true);
    });
  });

  describe("group remaining helpers", () => {
    test("getGroupRemainingByGroupId returns spots remaining for capped groups", async () => {
      const { e1, group } = await createCappedGroupWithListings(5, "remaining");
      await book(e1.id, 2);

      const map = await getGroupRemainingByGroupId([group.id]);
      expect(map.get(group.id)).toBe(3);
    });

    test("getGroupRemainingByGroupId uses editable booked quantities", async () => {
      const { e1, group } = await createCappedGroupWithListings(
        5,
        "manual-remaining",
      );
      await updateListingAggregateValues(e1.id, {
        booked_quantity: 4,
        tickets_count: 0,
      });

      const map = await getGroupRemainingByGroupId([group.id]);
      expect(map.get(group.id)).toBe(1);
    });

    test("getGroupRemainingByGroupId omits groups with no max set", async () => {
      const group = await createTestGroup({
        name: "unbounded",
        slug: "unbounded",
      });
      const map = await getGroupRemainingByGroupId([group.id]);
      expect(map.has(group.id)).toBe(false);
    });

    test("getGroupRemainingByGroupId returns empty map for empty input", async () => {
      const map = await getGroupRemainingByGroupId([]);
      expect(map.size).toBe(0);
    });

    test("getGroupRemainingByGroupId reports zero when group is exactly full", async () => {
      const { e1, group } = await createCappedGroupWithListings(
        2,
        "exact-fill",
      );
      await book(e1.id, 2);
      const map = await getGroupRemainingByGroupId([group.id]);
      expect(map.get(group.id)).toBe(0);
    });

    test("getGroupRemainingByListingId keys remaining by listing id", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(6, "for-listings");
      await book(e1.id, 4);

      const map = await getGroupRemainingByListingId([e1, e2]);
      expect(map.get(e1.id)).toBe(2);
      expect(map.get(e2.id)).toBe(2);
    });

    test("getGroupRemainingByListingId skips ungrouped listings", async () => {
      const ungrouped = await createTestListing({
        maxAttendees: 50,
        name: "loner",
      });
      const map = await getGroupRemainingByListingId([ungrouped]);
      expect(map.has(ungrouped.id)).toBe(false);
    });

    test("getGroupRemainingByListingId skips daily listings", async () => {
      const { e1 } = await createCappedGroupWithListings(3, "daily-skip", {
        listingType: "daily",
      });
      const map = await getGroupRemainingByListingId([e1]);
      expect(map.has(e1.id)).toBe(false);
    });

    test("getGroupRemainingForListing returns remaining for standard listing", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(4, "single-evt");
      await book(e1.id, 1);
      expect(await getGroupRemainingForListing(e2)).toBe(3);
    });

    test("getGroupRemainingForListing returns undefined for daily listing", async () => {
      const { e1 } = await createCappedGroupWithListings(3, "single-daily", {
        listingType: "daily",
      });
      expect(await getGroupRemainingForListing(e1)).toBeUndefined();
    });

    test("getGroupRemainingForListing returns undefined when no group", async () => {
      const ungrouped = await createTestListing({
        maxAttendees: 50,
        name: "no-group",
      });
      expect(await getGroupRemainingForListing(ungrouped)).toBeUndefined();
    });

    test("getGroupRemainingByGroupId is per-date for daily-listing groups", async () => {
      const { e1, group } = await createCappedGroupWithListings(
        4,
        "by-id-daily",
        {
          listingType: "daily",
        },
      );
      await book(e1.id, 3, "2026-09-01");
      await book(e1.id, 1, "2026-09-02");

      const onSep1 = await getGroupRemainingByGroupId([group.id], "2026-09-01");
      const onSep2 = await getGroupRemainingByGroupId([group.id], "2026-09-02");
      expect(onSep1.get(group.id)).toBe(1);
      expect(onSep2.get(group.id)).toBe(3);
    });

    test("getGroupRemainingByListingId returns daily listings when date is given", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(
        4,
        "by-evt-daily",
        {
          listingType: "daily",
        },
      );
      await book(e1.id, 1, "2026-10-01");

      const onOct1 = await getGroupRemainingByListingId([e1, e2], "2026-10-01");
      expect(onOct1.get(e1.id)).toBe(3);
      expect(onOct1.get(e2.id)).toBe(3);
    });

    test("getGroupRemainingForListing returns per-date remaining for daily listing", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(
        5,
        "single-daily-date",
        { listingType: "daily" },
      );
      await book(e1.id, 2, "2026-11-15");

      expect(await getGroupRemainingForListing(e2, "2026-11-15")).toBe(3);
      expect(await getGroupRemainingForListing(e2, "2026-11-16")).toBe(5);
    });
  });

  describe("getPackageDisplayForListings", () => {
    test("returns the package only when the listings are its exact members", async () => {
      const pkg = await createTestGroup({
        isPackage: true,
        name: "Bundle",
        slug: "bundle-disp",
      });
      const a = await createTestListing({ groupId: pkg.id, name: "A" });
      const b = await createTestListing({ groupId: pkg.id, name: "B" });

      expect(await getPackageDisplayForListings([a.id, b.id])).toEqual({
        hideListings: false,
        name: "Bundle",
      });
      // A subset of the members is not the whole package.
      expect(await getPackageDisplayForListings([a.id])).toBeNull();
      // Empty input short-circuits.
      expect(await getPackageDisplayForListings([])).toBeNull();
    });

    test("returns null for a non-package group's listings", async () => {
      const regular = await createTestGroup({ name: "Reg", slug: "reg-disp" });
      const listing = await createTestListing({
        groupId: regular.id,
        name: "Plain",
      });
      expect(await getPackageDisplayForListings([listing.id])).toBeNull();
    });
  });

  describe("anyListingInPackageGroup", () => {
    test("is false for empty input (no query)", async () => {
      expect(await anyListingInPackageGroup([])).toBe(false);
    });

    test("is true only for a member of a package group", async () => {
      const pkg = await createTestGroup({ isPackage: true, name: "Pkg" });
      const member = await createTestListing({ groupId: pkg.id, name: "Mem" });
      const regular = await createTestGroup({ name: "Reg" });
      const plain = await createTestListing({
        groupId: regular.id,
        name: "Pln",
      });

      expect(await anyListingInPackageGroup([member.id])).toBe(true);
      expect(await anyListingInPackageGroup([plain.id])).toBe(false);
    });
  });
});
