import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { withTransaction } from "#shared/db/client.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import {
  listingChildren,
  requireListingChildrenPackageCheck,
  setListingChildrenWithPackageCheckTx,
} from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

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

  test("names a malformed package check response", async () => {
    await expect(
      setListingChildrenWithPackageCheckTx(
        { batch: async () => [], execute: async () => emptyResultSet() },
        1,
        [2],
      ),
    ).rejects.toThrow("Missing package edge check");
  });
});
