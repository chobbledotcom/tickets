/** Transaction-level parent-edge writes: the addParentEdgesWithPackageCheckTx
 *  guard that checks parent existence and package edge conflicts inside the
 *  write transaction. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { withTransaction } from "#shared/db/client.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import {
  addParentEdgesWithPackageCheckTx,
  listingParents,
} from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
  },
);
