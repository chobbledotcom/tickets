import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllGroups, getListingsByGroupId } from "#shared/db/groups.ts";
import { getChildIds } from "#shared/db/listing-parents.ts";
import {
  adminFormPost,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  duplicateTestListing,
} from "#test-utils";

/** Set a parent's required children directly (mirrors the admin children form). */
const setChildren = async (
  parentId: number,
  childIds: number[],
): Promise<void> => {
  const { setChildIds } = await import("#shared/db/listing-parents.ts");
  await setChildIds(parentId, childIds);
};

/** Duplicate a whole group and return the cloned group's listings. */
const duplicateGroup = async (
  groupId: number,
  newName: string,
): Promise<Awaited<ReturnType<typeof getListingsByGroupId>>> => {
  await adminFormPost(`/admin/groups/${groupId}/bulk-actions/duplicate`, {
    date_find: "",
    date_replace: "",
    name_find: "",
    name_replace: "",
    new_name: newName,
  });
  const newGroup = (await getAllGroups()).find((g) => g.name === newName);
  return getListingsByGroupId(newGroup!.id);
};

describeWithEnv(
  "server > duplication copies parent/child edges",
  { db: true },
  () => {
    test("duplicating a parent copies its child edges onto the copy", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildren(parent.id, [child.id]);

      const copy = await duplicateTestListing(parent.id, { name: "Base copy" });

      expect(copy.id).not.toBe(parent.id);
      expect(await getChildIds(copy.id)).toEqual([child.id]);
      // The original is untouched.
      expect(await getChildIds(parent.id)).toEqual([child.id]);
    });

    test("duplicating a parent whose child became a parent skips the invalid edge", async () => {
      // A nested state the editor forbids but `setChildIds` can force: the child
      // C is both a child of P and a parent of D. Re-validating the copy's edge
      // P'->C fails (a child can't be a parent), so the copy gets no gate rather
      // than an invalid one.
      const parent = await createTestListing({ name: "Nested base" });
      const child = await createTestListing({ name: "Nested middle" });
      const grandchild = await createTestListing({ name: "Nested leaf" });
      await setChildren(parent.id, [child.id]);
      await setChildren(child.id, [grandchild.id]);

      const copy = await duplicateTestListing(parent.id, {
        name: "Nested base copy",
      });

      expect(await getChildIds(copy.id)).toEqual([]);
    });

    test("duplicating a non-parent listing adds no edges", async () => {
      const standalone = await createTestListing({ name: "Standalone" });

      const copy = await duplicateTestListing(standalone.id, {
        name: "Standalone copy",
      });

      expect(await getChildIds(copy.id)).toEqual([]);
    });

    test("duplicating a child yields a standalone copy with no edges", async () => {
      const parent = await createTestListing({ name: "Parent" });
      const child = await createTestListing({ name: "Child" });
      await setChildren(parent.id, [child.id]);

      const copy = await duplicateTestListing(child.id, { name: "Child copy" });

      // The copied child is not auto-attached under the original's parents,
      // and is not itself a parent.
      expect(await getChildIds(copy.id)).toEqual([]);
      expect(await getChildIds(parent.id)).toEqual([child.id]);
    });

    test("group duplicate remaps an intra-group parent/child edge to the clones", async () => {
      const group = await createTestGroup({ name: "Bundle" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Group parent",
      });
      const child = await createTestListing({
        groupId: group.id,
        name: "Group child",
      });
      await setChildren(parent.id, [child.id]);

      const copies = await duplicateGroup(group.id, "Bundle copy");

      const parentCopy = copies.find((l) => l.name === "Group parent")!;
      const childCopy = copies.find((l) => l.name === "Group child")!;
      // The cloned parent requires the cloned child, not the original.
      expect(await getChildIds(parentCopy.id)).toEqual([childCopy.id]);
      expect(childCopy.id).not.toBe(child.id);
    });

    test("group duplicate keeps an edge to a child outside the group", async () => {
      const group = await createTestGroup({ name: "External" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Inside parent",
      });
      const outsideChild = await createTestListing({ name: "Outside child" });
      await setChildren(parent.id, [outsideChild.id]);

      const copies = await duplicateGroup(group.id, "External copy");

      const parentCopy = copies.find((l) => l.name === "Inside parent")!;
      // The external child is referenced by its original id (not cloned).
      expect(await getChildIds(parentCopy.id)).toEqual([outsideChild.id]);
    });

    test("group duplicate does not auto-attach a member child whose parent is outside the group", async () => {
      const group = await createTestGroup({ name: "Child only" });
      const outsideParent = await createTestListing({ name: "Outside parent" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Inside child",
      });
      await setChildren(outsideParent.id, [child.id]);

      const copies = await duplicateGroup(group.id, "Child only copy");

      const childCopy = copies.find((l) => l.name === "Inside child")!;
      // The cloned child is standalone: the outside parent is not cloned, and
      // its clone is not attached to anything.
      expect(await getChildIds(outsideParent.id)).toEqual([child.id]);
      expect(await getChildIds(childCopy.id)).toEqual([]);
    });
  },
);
