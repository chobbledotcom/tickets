import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import {
  countRows,
  execute,
  writeRowInTransaction,
} from "#shared/db/client.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  setListingGroupsTx,
} from "#shared/db/groups.ts";
import { listingParents } from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { TransactionValidationError } from "#shared/db/transaction.ts";
import {
  generateUniqueListingSlug,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";

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

  test("keeps a concurrent listing import from mixing group types", async () => {
    const group = await createTestGroup({ name: "Import Race Group" });
    const standardInput = {
      ...testListingInput({ name: "Concurrent standard" }),
      ...(await generateUniqueListingSlug()),
      groupIds: [group.id],
    };
    expect(await validateListingInput(standardInput)).toBeNull();

    const [imported, standardWrite] = await Promise.allSettled([
      importCatalog({
        groups: [{ group: group.name }],
        kind: "listing",
        listing: customListing("Concurrent daily"),
        version: 1,
      }),
      writeRowInTransaction(
        await listingsTable.insertStatement!(standardInput),
        null,
        (tx, id) => setListingGroupsTx(tx, id, standardInput.groupIds),
      ),
    ]);

    const importSucceeded =
      imported.status === "fulfilled" && imported.value.ok;
    const standardSucceeded = standardWrite.status === "fulfilled";
    expect([importSucceeded, standardSucceeded].filter(Boolean)).toHaveLength(
      1,
    );
    if (imported.status === "fulfilled" && !imported.value.ok) {
      expect(imported.value.error).toBe(
        t("error.group_listing_type_mismatch", { type: "standard" }),
      );
    } else {
      expect(standardWrite.status).toBe("rejected");
      if (standardWrite.status !== "rejected") {
        throw new Error("The standard write should be rejected");
      }
      expect(standardWrite.reason).toBeInstanceOf(TransactionValidationError);
    }

    expect(
      new Set(
        (await getListingsByGroupId(group.id)).map(
          (listing) => listing.listing_type,
        ),
      ).size,
    ).toBe(1);
  });

  test("propagates an unexpected catalog write error", async () => {
    await execute(
      `CREATE TRIGGER reject_imported_listing
         BEFORE INSERT ON listings
         BEGIN SELECT RAISE(ABORT, 'import write failed'); END`,
    );

    await expect(
      importCatalog({
        kind: "listing",
        listing: { maxAttendees: 1, name: "Rejected write" },
        version: 1,
      }),
    ).rejects.toThrow("import write failed");
  });

  test("rechecks group members after importing their memberships", async () => {
    const first = await createTestListing({ name: "First imported member" });
    const second = await createTestListing({ name: "Second imported member" });
    await execute(
      `CREATE TRIGGER change_imported_member
         BEFORE INSERT ON group_listings
         WHEN NEW.listing_id = ${first.id}
         BEGIN
           UPDATE listings SET listing_type = 'daily' WHERE id = ${first.id};
         END`,
    );

    const result = await importCatalog({
      group: { name: "Rejected imported group" },
      kind: "group",
      members: [{ listing: first.name }, { listing: second.name }],
      version: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("The import should be rejected");
    expect(result.error).toBe(
      t("error.group_listing_type_mismatch", { type: "standard" }),
    );
  });

  test("rolls back an import when a member vanishes during its write", async () => {
    const member = await createTestListing({ name: "Vanishing import member" });
    await execute(
      `CREATE TRIGGER delete_imported_member
         BEFORE INSERT ON group_listings
         WHEN NEW.listing_id = ${member.id}
         BEGIN DELETE FROM listings WHERE id = ${member.id}; END`,
    );
    const before = await Promise.all([
      countRows("listings"),
      countRows("groups"),
      countRows("group_listings"),
    ]);

    const result = await importCatalog({
      group: { name: "Vanishing member group" },
      kind: "group",
      members: [{ listing: member.name }],
      version: 1,
    });

    expect(result).toEqual({
      error: t("catalog_transfer.member_missing"),
      ok: false,
    });
    expect(
      await Promise.all([
        countRows("listings"),
        countRows("groups"),
        countRows("group_listings"),
      ]),
    ).toEqual(before);
  });

  test("rolls back when a parent listing vanishes during import", async () => {
    const parent = await createTestListing({ name: "Vanishing parent" });
    // The parent is resolved from the name index before the transaction
    // opens. Once inside the transaction, the child listing INSERT fires this
    // trigger, deleting the parent before the package-aware edge check runs.
    // The check sees the parent is gone and rolls the whole import back
    // rather than leaving an orphan edge pointing at a deleted listing.
    await execute(
      `CREATE TRIGGER delete_imported_parent
         AFTER INSERT ON listings
         BEGIN DELETE FROM listings WHERE id = ${parent.id}; END`,
    );
    const before = await Promise.all([
      countRows("listings"),
      countRows("listing_parents"),
    ]);

    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 2, name: "Child of vanished" },
      parents: [parent.name],
      version: 1,
    });

    expect(result).toEqual({
      error: t("catalog_transfer.parent_missing"),
      ok: false,
    });
    // The trigger's delete and the child insert both roll back together.
    expect(
      await Promise.all([countRows("listings"), countRows("listing_parents")]),
    ).toEqual(before);
  });
});
