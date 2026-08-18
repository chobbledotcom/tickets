import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { withTransaction } from "#shared/db/client.ts";
import { guardEdgeWriteTx } from "#shared/db/listing-edge-write.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > listing-edge-write > guardEdgeWriteTx",
  { db: true },
  () => {
    const guard = async (
      params: Omit<Parameters<typeof guardEdgeWriteTx>[0], "tx">,
    ): Promise<unknown> =>
      withTransaction((tx) => guardEdgeWriteTx({ ...params, tx }));

    test("allows clearing an empty child set regardless of the parent's own state", async () => {
      // An empty save clears edges and is always allowed: when the parent is a
      // hidden-package member (the package conflict only applies once child
      // edges exist) and when the parent is itself a child (the nesting gate is
      // skipped once there are no edges to write).
      const expectEmptyClear = async (parentId: number): Promise<void> => {
        await expect(
          guard({
            childIds: [],
            contract: "children",
            missingParentError: t("error.listing_deleted"),
            parentIds: [parentId],
          }),
        ).resolves.toBeNull();
      };

      const { assignListingsToGroup } = await import(
        "#shared/db/groups/membership.ts"
      );
      const { createHiddenPackageGroup } = await import(
        "#test-utils/db-helpers/groups.ts"
      );
      const hiddenParent = await createTestListing({ name: "Hidden parent" });
      const hidden = await createHiddenPackageGroup("Hidden pkg");
      await assignListingsToGroup([hiddenParent.id], hidden.id);
      await expectEmptyClear(hiddenParent.id);

      const grandparent = await createTestListing({ name: "Grandparent" });
      const nestedParent = await createTestListing({ name: "Nested parent" });
      await listingChildren.setIds(grandparent.id, [nestedParent.id]);
      await expectEmptyClear(nestedParent.id);
    });

    test("rejects a vanished submitted parent with the parent-side message, parents path", async () => {
      const child = await createTestListing({ name: "Child" });
      const parent = await createTestListing({ name: "Vanishing parent" });
      const parentId = parent.id;
      await listingsTable.deleteById(parentId);

      await expect(
        guard({
          childIds: [child.id],
          contract: "parents",
          missingParentError: t("catalog_transfer.parent_missing"),
          parentIds: [parentId],
        }),
      ).rejects.toThrow(t("catalog_transfer.parent_missing"));
    });

    test("reports the nesting block each path prioritises, in that path's order", async () => {
      // `parent` is already a child (of grandparent) AND the fixed `child` is
      // already a parent (of grandchild) — both nesting blocks apply at once,
      // so each path must surface its own precedence.
      const nested = async () => {
        const grandparent = await createTestListing({ name: "Grandparent" });
        const parent = await createTestListing({ name: "Parent" });
        const child = await createTestListing({ name: "Child" });
        const grandchild = await createTestListing({ name: "Grandchild" });
        await listingChildren.setIds(grandparent.id, [parent.id]);
        await listingChildren.setIds(child.id, [grandchild.id]);
        return { child, parent };
      };

      // `parent` is already a child (of grandparent) AND the fixed `child` is
      // already a parent (of grandchild) — both nesting blocks apply at once,
      // so each path must surface its own precedence. The guard is read-only,
      // so both contracts run against the same fixture.
      const { child, parent } = await nested();
      await expect(
        guard({
          childIds: [child.id],
          contract: "children",
          missingParentError: t("error.listing_deleted"),
          parentIds: [parent.id],
        }),
      ).rejects.toThrow(t("error.parent_listing_nested"));

      await expect(
        guard({
          childIds: [child.id],
          contract: "parents",
          missingParentError: t("catalog_transfer.parent_missing"),
          parentIds: [parent.id],
        }),
      ).rejects.toThrow(t("error.child_listing_nested"));
    });

    test("rejects when the fixed child is itself a parent, children path", async () => {
      // The parent is fine, but the chosen child already has its own child.
      const parent = await createTestListing({ name: "Base" });
      const child = await createTestListing({ name: "Child" });
      const grandchild = await createTestListing({ name: "Grandchild" });
      await listingChildren.setIds(child.id, [grandchild.id]);

      await expect(
        guard({
          childIds: [child.id],
          contract: "children",
          missingParentError: t("error.listing_deleted"),
          parentIds: [parent.id],
        }),
      ).rejects.toThrow(t("error.child_listing_nested"));
    });

    test("rejects when the submitted parent is itself a child, parents path", async () => {
      // The fixed child is fine, but the submitted parent already has a parent.
      const grandparent = await createTestListing({ name: "Grandparent" });
      const parent = await createTestListing({ name: "Parent" });
      const child = await createTestListing({ name: "Child" });
      await listingChildren.setIds(grandparent.id, [parent.id]);

      await expect(
        guard({
          childIds: [child.id],
          contract: "parents",
          missingParentError: t("catalog_transfer.parent_missing"),
          parentIds: [parent.id],
        }),
      ).rejects.toThrow(t("error.parent_is_already_a_child"));
    });

    test("rejects when a submitted child no longer exists", async () => {
      const parent = await createTestListing({ name: "Base" });
      const child = await createTestListing({ name: "Vanishing child" });
      const childId = child.id;
      await listingsTable.deleteById(childId);
      await expect(
        guard({
          childIds: [childId],
          contract: "children",
          missingParentError: t("error.listing_deleted"),
          parentIds: [parent.id],
        }),
      ).rejects.toThrow(t("error.child_listing_deleted"));
    });

    test("returns the package conflict for the children contract", async () => {
      const { assignListingsToGroup } = await import(
        "#shared/db/groups/membership.ts"
      );
      const { createTestGroup } = await import(
        "#test-utils/db-helpers/groups.ts"
      );
      const parent = await createTestListing({ name: "Base" });
      const child = await createTestListing({ name: "Packaged child" });
      const group = await createTestGroup({ isPackage: true, name: "Pkg" });
      await assignListingsToGroup([child.id], group.id);

      await expect(
        guard({
          childIds: [child.id],
          contract: "children",
          missingParentError: t("error.listing_deleted"),
          parentIds: [parent.id],
        }),
      ).resolves.toBe("child_is_member");
    });
  },
);
