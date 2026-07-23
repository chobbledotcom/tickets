import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { getGroupPackagePrices } from "#shared/db/groups.ts";
import { listingParents } from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const importedId = async (blob: unknown): Promise<number> => {
  const result = await importCatalog(blob);
  if (!result.ok) throw new Error(result.error);
  return result.value.id;
};

const customListing = (name: string) => ({
  customisableDays: true,
  dayPrices: { 1: 1000, 2: 1800 },
  durationDays: 2,
  listingType: "daily",
  maxAttendees: 5,
  name,
});

describeWithEnv("catalog import persistence", { db: true }, () => {
  test("stores a package listing's free price, default quantity, and day price", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Day bundle",
    });
    const id = await importedId({
      groups: [
        {
          dayPrices: { 2: 700 },
          group: group.name,
          packagePrice: 0,
        },
      ],
      kind: "listing",
      listing: customListing("Package joiner"),
      version: 1,
    });

    expect(await getGroupPackagePrices(group.id)).toEqual([
      { group_id: group.id, listing_id: id, package_price: 0, quantity: 1 },
    ]);
    expect((await getGroupDayPrices(group.id)).get(id)).toEqual(
      new Map([[2, 700]]),
    );
  });

  test("clears package-only values when a listing joins a regular group", async () => {
    const group = await createTestGroup({ name: "Ordinary group" });
    const id = await importedId({
      groups: [
        {
          dayPrices: { 1: 200 },
          group: group.name,
          packagePrice: 300,
          quantity: 4,
        },
      ],
      kind: "listing",
      listing: customListing("Ordinary joiner"),
      version: 1,
    });

    expect(await getGroupPackagePrices(group.id)).toEqual([
      { group_id: group.id, listing_id: id, package_price: null, quantity: 1 },
    ]);
    expect([...(await getGroupDayPrices(group.id)).entries()]).toEqual([]);
  });

  test("does not import attachment storage fields", async () => {
    const id = await importedId({
      kind: "listing",
      listing: { maxAttendees: 2, name: "No copied files" },
      version: 1,
    });

    const listing = await getListingWithCount(id);
    expect(listing?.attachment_name).toBe("");
    expect(listing?.attachment_url).toBe("");
  });

  test("writes every resolved parent edge", async () => {
    const parent = await createTestListing({ name: "Stored parent" });
    const id = await importedId({
      kind: "listing",
      listing: { maxAttendees: 2, name: "Stored child" },
      parents: [parent.name],
      version: 1,
    });

    expect(await listingParents.getIds(id)).toEqual([parent.id]);
  });

  test("an omitted package flag keeps imported group members ordinary", async () => {
    const member = await createTestListing({ name: "Ordinary member" });
    const groupId = await importedId({
      group: { name: "Imported ordinary group" },
      kind: "group",
      members: [{ listing: member.name, packagePrice: 400, quantity: 3 }],
      version: 1,
    });

    expect(await getGroupPackagePrices(groupId)).toEqual([
      {
        group_id: groupId,
        listing_id: member.id,
        package_price: null,
        quantity: 1,
      },
    ]);
  });
});
