import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import {
  computeGroupSlugIndex,
  getGroupPackagePrices,
  getListingsByGroupId,
  getListingsByGroupIds,
  getListingsNotInGroup,
  groupExists,
  groups,
  isHiddenPackageMember,
  listingGroups,
  packageChildEdgeConflict,
  setGroupListingsActive,
  setGroupPackageMembers,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";

const insertMinimalGroup = async (name: string) => {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  return await groups.table.insert({
    name,
    slug,
    slugIndex: await computeGroupSlugIndex(slug),
  });
};

describeWithEnv("db > group storage contracts", { db: true }, () => {
  test("omitted group flags default to false", async () => {
    const inserted = await insertMinimalGroup("Default Flags");
    expect(await groups.table.findById(inserted.id)).toMatchObject({
      hidden: false,
      hide_package_listings: false,
      is_package: false,
    });
  });

  test("a group write refreshes an already-read group cache", async () => {
    expect(await groups.cache.getAll()).toEqual([]);

    const group = await insertMinimalGroup("Cache Refresh");

    expect((await groups.cache.getAll()).map(({ id }) => id)).toEqual([
      group.id,
    ]);
  });

  test("cache stats identify the group cache", () => {
    expect(
      getAllCacheStats().filter(({ name }) => name === "groups"),
    ).toHaveLength(1);
  });

  test("missing batch membership fails at the shared lookup", () => {
    expect(() => listingGroups.idsFor(new Map(), 42)).toThrow(
      "Missing listing group membership",
    );
  });

  test("groupExists distinguishes stored and missing groups", async () => {
    const group = await createTestGroup({ name: "Existing Group" });

    expect(await groupExists(group.id)).toBe(true);
    expect(await groupExists(group.id + 1)).toBe(false);
  });
});

describeWithEnv("db > group listing read contracts", { db: true }, () => {
  test("the batched default includes inactive members", async () => {
    const group = await createTestGroup({ name: "Batch Members" });
    const active = await createTestListing({ groupId: group.id, name: "Live" });
    const inactive = await createTestListing({
      groupId: group.id,
      name: "Paused",
    });
    await deactivateTestListing(inactive.id);

    const members = await getListingsByGroupIds([group.id]);

    expect(
      members
        .get(group.id)
        ?.map(({ id }) => id)
        .toSorted(),
    ).toEqual([active.id, inactive.id].toSorted());
  });

  test("the single-group read includes inactive members", async () => {
    const group = await createTestGroup({ name: "Single Members" });
    const inactive = await createTestListing({
      groupId: group.id,
      name: "Inactive Member",
    });
    await deactivateTestListing(inactive.id);

    expect((await getListingsByGroupId(group.id)).map(({ id }) => id)).toEqual([
      inactive.id,
    ]);
  });

  test("the add-listing candidates exclude current members", async () => {
    const group = await createTestGroup({ name: "Candidate Group" });
    await createTestListing({ groupId: group.id, name: "Current Member" });
    const candidate = await createTestListing({ name: "Candidate" });

    expect((await getListingsNotInGroup(group.id)).map(({ id }) => id)).toEqual(
      [candidate.id],
    );
  });
});

describeWithEnv("db > group validation contracts", { db: true }, () => {
  test("customisable-day errors describe the existing member", async () => {
    const customGroup = await createTestGroup({ name: "Custom Group" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      groupId: customGroup.id,
      name: "Custom Member",
    });
    expect(
      await validateGroupListingType(customGroup.id, "standard", false),
    ).toBe(
      "This group already contains listings with customisable days — all listings in a group must match",
    );

    const fixedGroup = await createTestGroup({ name: "Fixed Group" });
    await createTestListing({ groupId: fixedGroup.id, name: "Fixed Member" });
    expect(
      await validateGroupListingType(fixedGroup.id, "standard", true),
    ).toBe(
      "This group already contains listings without customisable days — all listings in a group must match",
    );
  });

  test("matching customisable-day settings are accepted", async () => {
    const group = await createTestGroup({ name: "Matching Custom Group" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      groupId: group.id,
      name: "Matching Custom Member",
    });

    expect(
      await validateGroupListingType(group.id, "standard", true),
    ).toBeNull();
  });

  test("a hidden package with no proposed children has no edge conflict", async () => {
    const hidden = await createHiddenPackageGroup("Hidden Empty Parent");

    expect(await packageChildEdgeConflict([hidden.id], [])).toBeNull();
  });

  test("the singular hidden-package check detects one membership", async () => {
    const hidden = await createHiddenPackageGroup("Hidden Member Group");
    const member = await createTestListing({
      groupId: hidden.id,
      name: "Hidden Member",
    });

    expect(await isHiddenPackageMember(member.id)).toBe(true);
  });
});

describeWithEnv("db > group package write contracts", { db: true }, () => {
  test("several package quantities are stored in one update", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Quantities",
    });
    const first = await createTestListing({ groupId: group.id, name: "First" });
    const second = await createTestListing({
      groupId: group.id,
      name: "Second",
    });

    await setGroupPackageMembers(group.id, [
      { listingId: first.id, price: null, quantity: 2 },
      { listingId: second.id, price: null, quantity: 3 },
    ]);

    expect(
      (await getGroupPackagePrices(group.id))
        .map(({ listing_id, quantity }): [number, number] => [
          listing_id,
          quantity,
        ])
        .toSorted(([left], [right]) => left - right),
    ).toEqual([
      [first.id, 2],
      [second.id, 3],
    ]);
  });

  test("bulk deactivation updates every member", async () => {
    const group = await createTestGroup({ name: "Deactivate Group" });
    const listing = await createTestListing({
      groupId: group.id,
      name: "Deactivate Member",
    });

    expect(await setGroupListingsActive(group.id, false)).toBe(1);
    expect((await getListingWithCount(listing.id))?.active).toBe(false);
  });

  test("bulk activation updates every member", async () => {
    const group = await createTestGroup({ name: "Activate Group" });
    const listing = await createTestListing({
      active: false,
      groupId: group.id,
      name: "Activate Member",
    });

    expect(await setGroupListingsActive(group.id, true)).toBe(1);
    expect((await getListingWithCount(listing.id))?.active).toBe(true);
  });
});
