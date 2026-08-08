import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import {
  computeGroupSlugIndex,
  getAllGroupNames,
  getGroupPackagePrices,
  getListingsByGroupId,
  getListingsByGroupIds,
  groupExists,
  groups,
  isHiddenPackageMember,
  listingGroups,
  packageMembersError,
  setGroupListingsActive,
  setGroupPackageMembers,
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
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";

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
    expect(await groups.table.read.one({ id: inserted.id })).toMatchObject({
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

  test("a second read inside the cache window does not query again", async () => {
    await insertMinimalGroup("Cache Window");
    await groups.cache.getAll();

    const { roundTrips } = await runAndCountRoundTrips(() =>
      groups.cache.getAll(),
    );

    expect(roundTrips).toBe(0);
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
});

describeWithEnv("db > group validation contracts", { db: true }, () => {
  test("the singular hidden-package check detects one membership", async () => {
    const hidden = await createHiddenPackageGroup("Hidden Member Group");
    const member = await createTestListing({
      groupId: hidden.id,
      name: "Hidden Member",
    });

    expect(await isHiddenPackageMember(member.id)).toBe(true);
  });

  test("the package error names the first listing that cannot be a member", async () => {
    const first = await createTestListing({
      canPayMore: true,
      name: "First Offender",
    });
    const second = await createTestListing({
      canPayMore: true,
      name: "Second Offender",
    });

    // Both listings are refused, so the message must come from the earlier one.
    expect(await packageMembersError([first, second], false)).toBe(
      t("error.package_member_pay_more", { name: "First Offender" }),
    );
  });

  test("every group name is read in one go", async () => {
    const first = await createTestGroup({ name: "Name Map One" });
    const second = await createTestGroup({ name: "Name Map Two" });

    expect(await getAllGroupNames()).toEqual(
      new Map([
        [first.id, "Name Map One"],
        [second.id, "Name Map Two"],
      ]),
    );
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
