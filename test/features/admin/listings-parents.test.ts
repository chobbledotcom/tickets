import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  copyDuplicatedChildEdges,
  loadListingParentsSection,
  remapDuplicatedGroupEdges,
  validateChildEdges,
} from "#routes/admin/listings-parents.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import { listingChildren, listingParents } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";

/** Create an active optional add-on attached to one group. */
const groupAddOn = async (name: string, groupId: number): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, {
    active: 1,
    scope: "groups",
    trigger: "optional",
  });
  await linkModifierGroup(modifier.id, groupId);
};

describeWithEnv("duplicated listing child edges", { db: true }, () => {
  test("does not copy an edge to a package member", async () => {
    const parent = await createTestListing({ name: "Copied Parent" });
    const child = await createTestListing({ name: "Packaged Child" });
    const group = await createTestGroup({
      isPackage: true,
      name: "Child Package",
    });
    expect(await assignListingsToGroup([child.id], group.id)).toBeNull();

    expect(await copyDuplicatedChildEdges(parent, [child.id])).toBe(
      t("error.package_child_is_member"),
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("loads an empty offered-under list and allows an ordinary candidate", async () => {
    const parent = await createTestListing({ name: "Base" });
    const candidate = await createTestListing({ name: "Add-on" });

    const section = await loadListingParentsSection(parent);

    expect(section.offeredUnder).toEqual([]);
    expect(section.childIds).toEqual(new Set());
    expect(section.candidates).toEqual([
      { ineligibleReason: null, listing: candidate },
    ]);
  });

  test("marks every candidate ineligible when the edited listing is a child", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    const candidate = await createTestListing({ name: "Candidate" });
    await listingChildren.setIds(grandparent.id, [parent.id]);

    const section = await loadListingParentsSection(parent);

    expect(section.offeredUnder).toEqual([grandparent]);
    expect(
      section.candidates.map(({ ineligibleReason, listing }) => ({
        id: listing.id,
        ineligibleReason,
      })),
    ).toEqual([
      {
        id: candidate.id,
        ineligibleReason: t("listings_table.children_err_parent_is_child", {
          name: "Parent",
        }),
      },
      {
        id: grandparent.id,
        ineligibleReason: t("listings_table.children_err_parent_is_child", {
          name: "Parent",
        }),
      },
    ]);
  });

  test("marks a candidate with children ineligible by name", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const candidate = await createTestListing({ name: "Candidate" });
    const grandchild = await createTestListing({ name: "Grandchild" });
    await listingChildren.setIds(candidate.id, [grandchild.id]);

    const section = await loadListingParentsSection(parent);

    expect(
      section.candidates.find(({ listing }) => listing.id === candidate.id),
    ).toEqual({
      ineligibleReason: t("listings_table.children_err_child_is_parent", {
        name: "Candidate",
      }),
      listing: candidate,
    });
  });

  test("cleans submitted ids before saving a valid edge", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });

    expect(
      await validateChildEdges(parent, [
        parent.id,
        child.id,
        child.id,
        999_999,
      ]),
    ).toEqual({ childIds: [child.id], ok: true });

    await listingChildren.setIds(grandparent.id, [parent.id]);
    expect(await validateChildEdges(parent, [child.id])).toEqual({
      error: t("listings_table.children_err_parent_is_child", {
        name: "Parent",
      }),
      ok: false,
    });
    expect(await validateChildEdges(parent, [])).toEqual({
      childIds: [],
      ok: true,
    });
  });

  test("rejects a submitted child that already has children", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const grandchild = await createTestListing({ name: "Grandchild" });
    await listingChildren.setIds(child.id, [grandchild.id]);

    expect(await validateChildEdges(parent, [child.id])).toEqual({
      error: t("listings_table.children_err_child_is_parent", {
        name: "Child",
      }),
      ok: false,
    });
  });

  test("remaps an existing parent's group before checking its child add-on", async () => {
    const group = await createTestGroup({ name: "Add-on group" });
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({
      groupId: group.id,
      name: "Child",
    });
    await groupAddOn("Group extra", group.id);

    expect(
      await validateChildEdges(parent, [child.id], {
        wouldBeGroupIds: [group.id],
      }),
    ).toEqual({ childIds: [child.id], ok: true });
  });

  test("adds a new parent to its submitted group before checking its child add-on", async () => {
    const group = await createTestGroup({ name: "Add-on group" });
    const child = await createTestListing({
      groupId: group.id,
      name: "Child",
    });
    await groupAddOn("Group extra", group.id);
    const pendingParent = { ...child, id: -1, name: "New parent" };

    expect(
      await validateChildEdges(pendingParent, [child.id], {
        wouldBeGroupIds: [group.id],
      }),
    ).toEqual({ childIds: [child.id], ok: true });
  });

  test("ignores an inactive add-on when validating a child edge", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const modifier = await insertModifier({ name: "Disabled extra" });
    await patchModifier(modifier.id, {
      active: 0,
      scope: "listings",
      trigger: "optional",
    });
    await linkModifierListing(modifier.id, child.id);

    expect(await validateChildEdges(parent, [child.id])).toEqual({
      childIds: [child.id],
      ok: true,
    });
  });

  test("remaps outgoing edges and keeps existing incoming siblings for a group copy", async () => {
    const sourceParent = await createTestListing({ name: "Source parent" });
    const sourceChild = await createTestListing({ name: "Source child" });
    const parentCopy = await createTestListing({ name: "Parent copy" });
    const childCopy = await createTestListing({ name: "Child copy" });
    const outsideParent = await createTestListing({ name: "Outside parent" });
    const staleChild = await createTestListing({ name: "Stale child" });
    const existingOutsideChild = await createTestListing({
      name: "Existing outside child",
    });
    await listingChildren.setIds(sourceParent.id, [sourceChild.id]);
    await listingChildren.setIds(outsideParent.id, [
      sourceChild.id,
      existingOutsideChild.id,
    ]);
    await listingChildren.setIds(parentCopy.id, [staleChild.id]);

    expect(
      await remapDuplicatedGroupEdges(
        new Map([
          [sourceParent.id, parentCopy.id],
          [sourceChild.id, childCopy.id],
        ]),
      ),
    ).toEqual([]);
    expect(await listingChildren.getIds(parentCopy.id)).toEqual([childCopy.id]);
    expect(await listingChildren.getIds(outsideParent.id)).toEqual(
      [sourceChild.id, existingOutsideChild.id, childCopy.id].toSorted(
        (left, right) => left - right,
      ),
    );
    expect(await listingParents.getIds(childCopy.id)).toEqual(
      [parentCopy.id, outsideParent.id].toSorted((left, right) => left - right),
    );
  });
});
