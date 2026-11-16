import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { checkListingAvailability as hasAvailableSpots } from "#db/attendees/capacity/checks.ts";
import {
  getGroupRemainingByGroupId,
  getGroupRemainingByListingId,
  getGroupRemainingForListing,
} from "#db/attendees/capacity/groups.ts";
import { getDb } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { getPackageDisplaysByIds } from "#db/groups/package-display.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  anyHiddenPackageGroup,
  anyListingInPackageGroup,
  getGroupBySlugIndex,
  getGroupPackagePrices,
  getGroupPackagePricesByGroupIds,
  getListingsByGroupIds,
  groups,
  isGroupSlugTaken,
  resetGroupListings,
  setGroupPackageMembers,
} from "#db/groups.ts";
import { listingAggregates } from "#db/listings/aggregates.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  batchFits,
  book,
  bookedCappedGroup,
  createCappedGroupWithListings,
  groupWithListing,
  memberListing,
} from "#test-utils/db-helpers/group-capacity.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectMapValues } from "#test-utils/map-values.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";

describeWithEnv("db > groups", { db: true, triggers: true }, () => {
  describe("CRUD", () => {
    test("groups.table create, update, read, deleteById", async () => {
      const created = await createTestGroup({
        name: "DB Group",
        slug: "db-group",
      });

      const fetched = await records.groups.find(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("DB Group");
      expect(fetched?.slug).toBe("db-group");

      const updated = await records.groups.update(created.id, {
        name: "DB Group Updated",
        terms_and_conditions: "Terms",
      });
      expect(updated?.name).toBe("DB Group Updated");
      expect(updated?.terms_and_conditions).toBe("Terms");

      await records.groups.delete(created.id);
      expect(await records.groups.find(created.id)).toBeNull();
    });

    test("getAllGroups returns decrypted groups ordered by id", async () => {
      const g1 = await createTestGroup({ name: "Group A", slug: "group-a" });
      const g2 = await createTestGroup({ name: "Group B", slug: "group-b" });
      const allGroups = await groups.getAll();
      expect(allGroups.length).toBe(2);
      expect(allGroups[0]?.id).toBe(g1.id);
      expect(allGroups[1]?.id).toBe(g2.id);
      expect(allGroups[0]?.name).toBe("Group A");
      expect(allGroups[1]?.name).toBe("Group B");
    });

    test("getGroupBySlugIndex returns group or null", async () => {
      const group = await createTestGroup({
        name: "Index Group",
        slug: "idx-group",
      });

      const found = await getGroupBySlugIndex(await hmacHash("idx-group"));
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

    test("getListingsByGroupIds batches active members by group id", async () => {
      const populated = await createTestGroup({
        name: "Populated",
        slug: "batch-populated",
      });
      const empty = await createTestGroup({
        name: "Empty",
        slug: "batch-empty",
      });
      const active = await memberListing(populated, "Batch Active");
      const inactive = await memberListing(populated, "Batch Inactive");
      // A listing shared by both groups proves the join is resolved per group.
      const shared = await memberListing(populated, "Batch Shared");
      await assignListingsToGroup([shared.id], empty.id);
      await getDb().execute(
        sql`UPDATE listings SET active = 0 WHERE id = ${inactive.id}`,
      );
      const attendee = await bookAttendee(active, {
        email: "batch-a@example.com",
        name: "A",
        quantity: 3,
      });
      if (!attendee.success) throw new Error("Failed to create attendee");

      const byGroup = await getListingsByGroupIds(
        [populated.id, empty.id],
        true,
      );
      // The inactive member is dropped; the shared active one appears under both.
      expect(
        byGroup
          .get(populated.id)
          ?.map((l) => l.id)
          .sort(),
      ).toEqual([active.id, shared.id].sort((a, b) => a - b));
      expect(byGroup.get(empty.id)?.map((l) => l.id)).toEqual([shared.id]);
      // The active members come with their booked counts.
      const activeMember = byGroup
        .get(populated.id)
        ?.find((l) => l.id === active.id);
      expect(activeMember?.attendee_count).toBe(3);
    });

    test("getListingsByGroupIds maps a memberless group to an empty list", async () => {
      const bare = await createTestGroup({ name: "Bare", slug: "batch-bare" });
      const byGroup = await getListingsByGroupIds([bare.id], true);
      expect(byGroup.get(bare.id)).toEqual([]);
      // No ids ⇒ empty map, no query.
      expect((await getListingsByGroupIds([], true)).size).toBe(0);
    });

    test("resetGroupListings removes every membership row", async () => {
      const { group, listing } = await groupWithListing(
        { name: "Reset Group", slug: "reset-group" },
        "Reset Listing",
      );
      await resetGroupListings(group.id);
      expect(await listingGroups.getIds(listing.id)).toEqual([]);
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
      const { listing } = await groupWithListing(
        { name: "unlimited", slug: "unlimited" },
        "unlimited-listing",
        100,
      );

      expect((await book(listing.id, 50)).success).toBe(true);
    });

    test("hasAvailableSpots checks group capacity", async () => {
      const { e2 } = await bookedCappedGroup(3, "spots", 2);

      expect(await hasAvailableSpots(e2.id, 1)).toBe(true);
      expect(await hasAvailableSpots(e2.id, 2)).toBe(false);
    });

    test("checkBatchAvailability checks group capacity", async () => {
      const { e1, e2 } = await createCappedGroupWithListings(4, "batch");

      expect(
        await batchFits([
          [e1, 3],
          [e2, 2],
        ]),
      ).toBe(false);

      expect(
        await batchFits([
          [e1, 2],
          [e2, 2],
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability skips group check when group has no limit", async () => {
      const { listing: e1 } = await groupWithListing(
        { name: "no-limit", slug: "no-limit" },
        "no-limit-a",
        100,
      );
      const ungrouped = await createTestListing({
        maxAttendees: 100,
        name: "ungrouped",
      });

      expect(
        await batchFits([
          [e1, 50],
          [ungrouped, 50],
        ]),
      ).toBe(true);
    });

    test("checkBatchAvailability handles listings from multiple groups", async () => {
      const { e1: eA } = await createCappedGroupWithListings(3, "multi-a");
      const { e1: eB } = await createCappedGroupWithListings(3, "multi-b");

      expect(
        await batchFits([
          [eA, 2],
          [eB, 2],
        ]),
      ).toBe(true);
    });

    test("capacity check handles deleted group gracefully", async () => {
      const { group, listing } = await groupWithListing(
        { maxAttendees: 5, name: "delete-me", slug: "delete-me" },
        "orphan-listing",
      );
      await records.groups.delete(group.id);

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
        await batchFits(
          [
            [e1, 3],
            [e2, 3],
          ],
          "2026-09-01",
        ),
      ).toBe(false);

      expect(
        await batchFits(
          [
            [e1, 2],
            [e2, 3],
          ],
          "2026-09-01",
        ),
      ).toBe(true);
    });

    test("checkBatchAvailability considers pre-existing attendees in group", async () => {
      const { e2 } = await bookedCappedGroup(5, "pre-exist", 3);

      expect(await batchFits([[e2, 3]])).toBe(false);

      expect(await batchFits([[e2, 2]])).toBe(true);
    });

    test("listing-level cap rejects even when group has room", async () => {
      const { listing } = await groupWithListing(
        { maxAttendees: 100, name: "big-group", slug: "big-group" },
        "small-listing",
        2,
      );

      expect((await book(listing.id, 2)).success).toBe(true);
      const r = await book(listing.id, 1);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.reason).toBe("capacity_exceeded");
    });

    test("hasAvailableSpots respects listing cap even when group has room", async () => {
      const { listing } = await groupWithListing(
        { maxAttendees: 100, name: "big-group2", slug: "big-group2" },
        "tiny-listing",
        1,
      );

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
        await batchFits([
          [fullGroupListing, 1],
          [openGroupListing, 1],
        ]),
      ).toBe(false);

      expect(await batchFits([[openGroupListing, 1]])).toBe(true);
    });
  });

  describe("group remaining helpers", () => {
    /** A capped daily group, its two listings, and `e1` booked on each date. */
    const dailyGroupBookedOn = async (
      max: number,
      slug: string,
      bookings: readonly (readonly [date: string, qty: number])[],
    ) => {
      const { e1, e2, group } = await createCappedGroupWithListings(max, slug, {
        listingType: "daily",
      });
      for (const [date, qty] of bookings) await book(e1.id, qty, date);
      return { e1, e2, group };
    };

    /** A capped group booked to `quantity`, and the spots that leaves. */
    for (const [name, slug, max, quantity, remaining] of [
      [
        "getGroupRemainingByGroupId returns spots remaining for capped groups",
        "remaining",
        5,
        2,
        3,
      ],
      [
        "getGroupRemainingByGroupId reports zero when group is exactly full",
        "exact-fill",
        2,
        2,
        0,
      ],
    ] as const) {
      test(name, async () => {
        const { group } = await bookedCappedGroup(max, slug, quantity);

        const map = await getGroupRemainingByGroupId([group.id]);
        expect(map.get(group.id)).toBe(remaining);
      });
    }

    test("getGroupRemainingByGroupId uses editable booked quantities", async () => {
      const { e1, group } = await createCappedGroupWithListings(
        5,
        "manual-remaining",
      );
      await listingAggregates.update(e1.id, {
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

    test("getGroupRemainingByListingId keys remaining by listing id", async () => {
      const { e1, e2 } = await bookedCappedGroup(6, "for-listings", 4);

      const map = await getGroupRemainingByListingId([e1, e2]);
      expectMapValues(map, [
        [e1, 2],
        [e2, 2],
      ]);
    });

    /** Each listing kind the by-listing helper must skip. */
    const skippedListings = [
      {
        listing: () => createTestListing({ maxAttendees: 50, name: "loner" }),
        name: "getGroupRemainingByListingId skips ungrouped listings",
      },
      {
        listing: async () =>
          (
            await createCappedGroupWithListings(3, "daily-skip", {
              listingType: "daily",
            })
          ).e1,
        name: "getGroupRemainingByListingId skips daily listings",
      },
    ];

    for (const { listing, name } of skippedListings) {
      test(name, async () => {
        const skipped = await listing();
        const map = await getGroupRemainingByListingId([skipped]);
        expect(map.has(skipped.id)).toBe(false);
      });
    }

    test("getGroupRemainingForListing returns remaining for standard listing", async () => {
      const { e2 } = await bookedCappedGroup(4, "single-evt", 1);
      expect(await getGroupRemainingForListing(e2)).toBe(3);
    });

    /** Each listing kind the single-listing helper cannot answer for. */
    const noRemainingListings = [
      {
        listing: async () =>
          (
            await createCappedGroupWithListings(3, "single-daily", {
              listingType: "daily",
            })
          ).e1,
        name: "getGroupRemainingForListing returns undefined for daily listing",
      },
      {
        listing: () =>
          createTestListing({ maxAttendees: 50, name: "no-group" }),
        name: "getGroupRemainingForListing returns undefined when no group",
      },
    ];

    for (const { listing, name } of noRemainingListings) {
      test(name, async () => {
        expect(await getGroupRemainingForListing(await listing())).toBe(
          undefined,
        );
      });
    }

    test("getGroupRemainingByGroupId is per-date for daily-listing groups", async () => {
      const { group } = await dailyGroupBookedOn(4, "by-id-daily", [
        ["2026-09-01", 3],
        ["2026-09-02", 1],
      ]);

      const onSep1 = await getGroupRemainingByGroupId([group.id], "2026-09-01");
      const onSep2 = await getGroupRemainingByGroupId([group.id], "2026-09-02");
      expect(onSep1.get(group.id)).toBe(1);
      expect(onSep2.get(group.id)).toBe(3);
    });

    test("getGroupRemainingByListingId returns daily listings when date is given", async () => {
      const { e1, e2 } = await dailyGroupBookedOn(4, "by-evt-daily", [
        ["2026-10-01", 1],
      ]);

      const onOct1 = await getGroupRemainingByListingId([e1, e2], "2026-10-01");
      expectMapValues(onOct1, [
        [e1, 3],
        [e2, 3],
      ]);
    });

    test("getGroupRemainingForListing returns per-date remaining for daily listing", async () => {
      const { e2 } = await dailyGroupBookedOn(5, "single-daily-date", [
        ["2026-11-15", 2],
      ]);

      expect(await getGroupRemainingForListing(e2, "2026-11-15")).toBe(3);
      expect(await getGroupRemainingForListing(e2, "2026-11-16")).toBe(5);
    });
  });

  describe("getPackageDisplaysByIds", () => {
    test("loads several package displays in one round trip", async () => {
      const pkg = await createTestGroup({
        isPackage: true,
        name: "Bundle",
        slug: "bundle-disp",
      });
      const hidden = await createHiddenPackageGroup("Hidden Bundle");
      const regular = await createTestGroup({
        name: "Regular",
        slug: "regular-disp",
      });
      const { roundTrips, value } = await runAndCountRoundTrips(() =>
        getPackageDisplaysByIds([
          pkg.id,
          hidden.id,
          regular.id,
          pkg.id,
          0,
          -1,
          987654,
        ]),
      );

      expect(roundTrips).toBe(1);
      expect(value).toEqual(
        new Map([
          [pkg.id, { hideListings: false, name: "Bundle" }],
          [hidden.id, { hideListings: true, name: "Hidden Bundle" }],
        ]),
      );
    });

    test("returns no displays when no ids are requested", async () => {
      const { roundTrips, value } = await runAndCountRoundTrips(() =>
        getPackageDisplaysByIds([]),
      );

      expect(roundTrips).toBe(0);
      expect(value).toEqual(new Map());
    });

    test("does not query for standalone package markers", async () => {
      const { roundTrips, value } = await runAndCountRoundTrips(() =>
        getPackageDisplaysByIds([0, 0, -1]),
      );

      expect(roundTrips).toBe(0);
      expect(value).toEqual(new Map());
    });

    test("reflects package changes after cache invalidation", async () => {
      const pkg = await createTestGroup({
        isPackage: true,
        name: "Changed Bundle",
        slug: "changed-bundle-disp",
      });
      expect((await getPackageDisplaysByIds([pkg.id])).get(pkg.id)).toEqual({
        hideListings: false,
        name: "Changed Bundle",
      });

      await records.groups.update(pkg.id, { hide_package_listings: true });

      expect((await getPackageDisplaysByIds([pkg.id])).get(pkg.id)).toEqual({
        hideListings: true,
        name: "Changed Bundle",
      });
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

  describe("anyHiddenPackageGroup", () => {
    test("is false for empty input (no query)", async () => {
      expect(await anyHiddenPackageGroup([])).toBe(false);
    });

    test("is true only for a package that hides its listings", async () => {
      const hidden = await createHiddenPackageGroup("Hidden Package Check");
      const plain = await createTestGroup({ name: "Plain Group Check" });
      // A package that shows its listings has nothing to conceal.
      const shown = await createTestGroup({
        isPackage: true,
        name: "Shown Package Check",
      });

      expect(await anyHiddenPackageGroup([hidden.id])).toBe(true);
      expect(await anyHiddenPackageGroup([plain.id])).toBe(false);
      expect(await anyHiddenPackageGroup([shown.id])).toBe(false);
    });
  });

  describe("getGroupPackagePricesByGroupIds", () => {
    test("returns an empty map for no group ids (no query)", async () => {
      const result = await getGroupPackagePricesByGroupIds([]);
      expect(result.size).toBe(0);
    });

    test("groups membership rows by group id in one query", async () => {
      const a = await createTestGroup({
        isPackage: true,
        name: "A",
        slug: "a",
      });
      const a1 = await createTestListing({ groupId: a.id, name: "A1" });
      const a2 = await createTestListing({ groupId: a.id, name: "A2" });
      const b = await createTestGroup({
        isPackage: true,
        name: "B",
        slug: "b",
      });
      const b1 = await createTestListing({ groupId: b.id, name: "B1" });
      await setGroupPackageMembers(a.id, [
        { listingId: a1.id, price: 100, quantity: 1 },
        { listingId: a2.id, price: 200, quantity: 3 },
      ]);
      await setGroupPackageMembers(b.id, [
        { listingId: b1.id, price: 500, quantity: 1 },
      ]);

      const result = await getGroupPackagePricesByGroupIds([a.id, b.id]);
      expect(result.get(a.id)?.length).toBe(2);
      expect(result.get(b.id)?.length).toBe(1);
      // Each row carries its override price for the right group.
      const a2Row = result.get(a.id)?.find((r) => r.listing_id === a2.id);
      expect(a2Row?.package_price).toBe(200);
      expect(a2Row?.quantity).toBe(3);
    });
  });

  describe("package_price override states", () => {
    test("stores null (no override), 0 (free), and a positive override distinctly", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Tri",
        slug: "tri",
      });
      const none = await createTestListing({ groupId: group.id, name: "None" });
      const free = await createTestListing({ groupId: group.id, name: "Free" });
      const paid = await createTestListing({ groupId: group.id, name: "Paid" });
      await setGroupPackageMembers(group.id, [
        { listingId: none.id, price: null },
        { listingId: free.id, price: 0 },
        { listingId: paid.id, price: 1500 },
      ]);

      const rows = await getGroupPackagePrices(group.id);
      const priceOf = (id: number) =>
        rows.find((r) => r.listing_id === id)?.package_price;
      // null and 0 are preserved as distinct values, not collapsed together.
      expect(priceOf(none.id)).toBeNull();
      expect(priceOf(free.id)).toBe(0);
      expect(priceOf(paid.id)).toBe(1500);
    });
  });
});
