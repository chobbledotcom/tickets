/** Transaction-level parent-edge writes: the addParentEdgesWithPackageCheckTx
 *  guard that checks parent existence and package edge conflicts inside the
 *  write transaction. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership.ts";
import {
  addParentEdgesWithPackageCheckTx,
  listingChildren,
  listingParents,
} from "#db/listing-parents.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";

describeWithEnv(
  "db > listing-parents > addParentEdgesWithPackageCheckTx",
  { db: true },
  () => {
    test("adds parent edges when the parents exist", async () => {
      const parent = await createTestListing({ name: "Real parent" });
      const child = await createTestListing({ name: "Real child" });

      await withTransaction(async (tx) => {
        await addParentEdgesWithPackageCheckTx(
          tx,
          child.id,
          [parent.id],
          t("catalog_transfer.parent_missing"),
        );
      });

      expect(await listingParents.getIds(child.id)).toEqual([parent.id]);
    });

    test("rolls back when a parent listing has been deleted", async () => {
      const child = await createTestListing({ name: "Orphaned child" });

      await expect(
        withTransaction(async (tx) => {
          await addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [99999],
            t("catalog_transfer.parent_missing"),
          );
        }),
      ).rejects.toThrow(t("catalog_transfer.parent_missing"));
    });

    test("rolls back when an imported parent became a child", async () => {
      const grandparent = await createTestListing({
        name: "Import grandparent",
      });
      const parent = await createTestListing({ name: "Nested import parent" });
      const child = await createTestListing({ name: "Imported child" });
      await listingChildren.setIds(grandparent.id, [parent.id]);

      await expect(
        withTransaction((tx) =>
          addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [parent.id],
            t("catalog_transfer.parent_missing"),
          ),
        ),
      ).rejects.toThrow(t("error.parent_listing_nested"));
      expect(await listingParents.getIds(child.id)).toEqual([]);
    });

    test("rolls back when the child already has its own children", async () => {
      const parent = await createTestListing({ name: "Import parent" });
      const child = await createTestListing({ name: "Import child" });
      const grandchild = await createTestListing({ name: "Import grandchild" });
      // The imported child is itself a parent, so adding a parent above it
      // would create the two-level nesting the rule forbids.
      await listingChildren.setIds(child.id, [grandchild.id]);

      await expect(
        withTransaction((tx) =>
          addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [parent.id],
            t("catalog_transfer.parent_missing"),
          ),
        ),
      ).rejects.toThrow(t("error.child_listing_nested"));
      expect(await listingParents.getIds(child.id)).toEqual([]);
    });

    test("does nothing when parentIds is empty", async () => {
      const child = await createTestListing({ name: "No-edge child" });

      await withTransaction(async (tx) => {
        await addParentEdgesWithPackageCheckTx(
          tx,
          child.id,
          [],
          t("catalog_transfer.parent_missing"),
        );
      });

      expect(await listingParents.getIds(child.id)).toEqual([]);
    });

    test("rolls back when the child is a package member and the parent is in a hidden package", async () => {
      const hiddenPackage = await createHiddenPackageGroup("Edge hidden pkg");
      const packageGroup = await createTestGroup({
        isPackage: true,
        name: "Edge child pkg",
      });
      const parent = await createTestListing({ name: "Edge parent" });
      const child = await createTestListing({ name: "Edge child" });
      await assignListingsToGroup([parent.id], hiddenPackage.id);
      await assignListingsToGroup([child.id], packageGroup.id);

      await expect(
        withTransaction(async (tx) => {
          await addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [parent.id],
            t("catalog_transfer.parent_missing"),
          );
        }),
      ).rejects.toThrow(t("error.package_gate_in_hidden"));
      expect(await listingParents.getIds(child.id)).toEqual([]);
    });

    test("rolls back when current edge fields are incompatible", async () => {
      const parent = await createTestListing({ name: "Standard parent" });
      const child = await createTestListing({
        listingType: "daily",
        name: "Daily imported child",
      });

      await expect(
        withTransaction((tx) =>
          addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [parent.id],
            t("catalog_transfer.parent_missing"),
          ),
        ),
      ).rejects.toThrow(
        t("listings_table.children_err_child_daily", { name: child.name }),
      );
      expect(await listingParents.getIds(child.id)).toEqual([]);
    });

    test("rolls back when the child has an active child-only add-on", async () => {
      const parent = await createTestListing({ name: "Add-on parent" });
      const child = await createTestListing({ name: "Add-on import child" });
      await optInAddOnForListings("Imported child extra", [child.id]);

      await expect(
        withTransaction((tx) =>
          addParentEdgesWithPackageCheckTx(
            tx,
            child.id,
            [parent.id],
            t("catalog_transfer.parent_missing"),
          ),
        ),
      ).rejects.toThrow("Imported child extra");
      expect(await listingParents.getIds(child.id)).toEqual([]);
    });
  },
);
