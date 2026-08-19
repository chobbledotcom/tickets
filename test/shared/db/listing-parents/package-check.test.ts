import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership.ts";
import {
  listingChildren,
  requireListingChildrenPackageCheck,
  setListingChildrenWithPackageCheckTx,
} from "#db/listing-parents.ts";
import { listingsTable } from "#db/listings/records.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";

describeWithEnv("db > listing-parents > package check", { db: true }, () => {
  const parentAndChild = async () => ({
    child: await createTestListing({ name: "Add-on" }),
    parent: await createTestListing({ name: "Base unit" }),
  });

  test("refuses a child packaged after edge validation", async () => {
    const { parent, child } = await parentAndChild();
    const packageGroup = await createTestGroup({
      isPackage: true,
      name: "Child Package",
    });
    expect(await assignListingsToGroup([child.id], packageGroup.id)).toBeNull();

    expect(
      await withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).toBe("child_is_member");
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("throws the package rule from the transaction writer", async () => {
    const { parent, child } = await parentAndChild();
    const packageGroup = await createTestGroup({
      isPackage: true,
      name: "Throwing Child Package",
    });
    await assignListingsToGroup([child.id], packageGroup.id);

    await expect(
      withTransaction(async (tx) =>
        requireListingChildrenPackageCheck(
          await setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
        ),
      ),
    ).rejects.toMatchObject({
      message: t("error.package_child_is_member"),
      name: "TransactionValidationError",
    });
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("replaces children when the package check allows the new edge", async () => {
    const { parent, child } = await parentAndChild();
    const replacement = await createTestListing({ name: "Replacement add-on" });
    await listingChildren.setIds(parent.id, [child.id]);

    expect(
      await withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [replacement.id]),
      ),
    ).toBeNull();
    expect(await listingChildren.getIds(parent.id)).toEqual([replacement.id]);
  });

  test("rolls back when a child endpoint was deleted before the tx", async () => {
    const { parent, child } = await parentAndChild();
    await listingsTable.deleteById(child.id);

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toBeInstanceOf(TransactionValidationError);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects when the parent endpoint was deleted before the tx", async () => {
    const child = await createTestListing({ name: "Orphaned child" });
    const parent = await createTestListing({ name: "Vanished parent" });
    await listingsTable.deleteById(parent.id);

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toThrow(t("error.listing_deleted"));
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects when the parent became a child after validation", async () => {
    const { parent, child } = await parentAndChild();
    const grandparent = await createTestListing({ name: "Outer parent" });
    await listingChildren.setIds(grandparent.id, [parent.id]);

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toThrow(t("error.parent_listing_nested"));
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects when a child gained children after validation", async () => {
    const { parent, child } = await parentAndChild();
    const grandchild = await createTestListing({ name: "Nested child" });
    await listingChildren.setIds(child.id, [grandchild.id]);

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toThrow(t("error.child_listing_nested"));
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects edge fields changed after validation", async () => {
    const { parent, child } = await parentAndChild();
    await listingsTable.update(child.id, { listingType: "daily" });

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toThrow(
      t("listings_table.children_err_child_daily", { name: child.name }),
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects an add-on activated after validation", async () => {
    const { parent, child } = await parentAndChild();
    await optInAddOnForListings("Child extra", [child.id]);

    await expect(
      withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
      ),
    ).rejects.toThrow("Child extra");
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });
});
