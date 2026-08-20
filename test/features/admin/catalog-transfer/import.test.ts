import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getGroupPackagePrices, getListingsByGroupId } from "#db/groups.ts";
import { t } from "#i18n";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("catalog group import", { db: true }, () => {
  test("creates a group with its named member", async () => {
    const member = await createTestListing({ name: "Group import member" });

    const result = await importCatalog({
      group: { name: "Imported group" },
      kind: "group",
      members: [{ listing: member.name }],
      version: 1,
    });

    expect(result).toEqual({
      ok: true,
      value: { id: expect.any(Number), kind: "group", name: "Imported group" },
    });
    if (!result.ok) throw new Error(result.error);
    expect(
      (await getListingsByGroupId(result.value.id)).map(
        (listing) => listing.id,
      ),
    ).toEqual([member.id]);
  });

  test("reports a missing group member", async () => {
    const result = await importCatalog({
      group: { name: "Missing member group" },
      kind: "group",
      members: [{ listing: "Missing group member" }],
      version: 1,
    });

    expect(result).toEqual({
      error:
        'No listing named "Missing group member" exists — it must already exist to import this reference.',
      ok: false,
    });
  });

  test("clears package values when importing an ordinary group", async () => {
    const member = await createTestListing({
      canPayMore: true,
      name: "Ordinary group member",
    });
    const result = await importCatalog({
      group: { name: "Ordinary imported group" },
      kind: "group",
      members: [{ listing: member.name, packagePrice: 500, quantity: 2 }],
      version: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const [stored] = await getGroupPackagePrices(result.value.id);
    if (!stored) throw new Error("The imported group membership is missing");
    expect({
      listing_id: stored.listing_id,
      package_price: stored.package_price,
      quantity: stored.quantity,
    }).toEqual({
      listing_id: member.id,
      package_price: null,
      quantity: 1,
    });
  });

  test("rejects a package day override the member cannot offer", async () => {
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      listingType: "daily",
      name: "Package day member",
    });
    const result = await importCatalog({
      group: { isPackage: true, name: "Package day group" },
      kind: "group",
      members: [{ dayPrices: { 5: 500 }, listing: member.name }],
      version: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("The package import should be rejected");
    expect(result.error).toContain("5-day");
  });
});

describeWithEnv("in-tx member validation", { db: true }, () => {
  test("rejects an import when a resolved member vanishes inside its transaction", async () => {
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      listingType: "daily",
      name: "Tx missing member",
    });
    await execute(
      `CREATE TRIGGER delete_member_after_group_insert
         AFTER INSERT ON groups
         BEGIN DELETE FROM listings WHERE id = ${member.id}; END`,
    );

    expect(
      await importCatalog({
        group: { isPackage: true, name: "Tx missing member group" },
        kind: "group",
        members: [{ listing: member.name }],
        version: 1,
      }),
    ).toEqual({ error: t("catalog_transfer.member_missing"), ok: false });
  });
});
