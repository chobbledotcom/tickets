import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { listingChildren, listingParents } from "#db/listing-parents.ts";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import {
  copyDuplicatedChildEdges,
  loadListingParentsSection,
  remapDuplicatedGroupEdges,
  validateChildEdges,
} from "#routes/admin/listings-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { parentAndChild } from "#test-utils/listing-parents/helpers.ts";
import {
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
  patchModifier,
} from "#test-utils/modifiers.ts";
import { createNamedListings } from "#test-utils/named-listings.ts";
import type { ListingWithCount } from "#types";

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

/** Break a child so the duplicate's edge write refuses it, and the message the
 * copy returns. The package case refuses at validation; the deleted child
 * passes validation from the request cache, so only the write's own existence
 * re-check inside the transaction can refuse it. */
const ineligibleChildCases = [
  {
    breakChild: async (child: ListingWithCount): Promise<void> => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Child Package",
      });
      expect(await assignListingsToGroup([child.id], group.id)).toBeNull();
    },
    message: "error.package_child_is_member",
    name: "does not copy an edge to a package member",
  },
  {
    breakChild: async (child: ListingWithCount): Promise<void> => {
      await executeWithoutCacheInvalidation(
        sql`DELETE FROM listings WHERE id = ${child.id}`,
      );
    },
    message: "error.child_listing_deleted",
    name: "returns a warning when a child vanishes before the edge write",
  },
];

describeWithEnv("duplicated listing child edges", { db: true }, () => {
  for (const { breakChild, message, name } of ineligibleChildCases) {
    test(name, async () => {
      const { parent, child } = await parentAndChild();
      await breakChild(child);

      expect(await copyDuplicatedChildEdges(parent, [child.id])).toBe(
        t(message),
      );
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });
  }

  test("loads an empty offered-under list and allows an ordinary candidate", async () => {
    const { child: candidate, parent } = await parentAndChild();

    const section = await loadListingParentsSection(parent);

    expect(section.offeredUnder).toEqual([]);
    expect(section.childIds).toEqual(new Set());
    expect(section.candidates).toEqual([
      { ineligibleReason: null, listing: candidate },
    ]);
  });

  test("marks every candidate ineligible when the edited listing is a child", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const { child: candidate, parent } = await parentAndChild();
    await listingChildren.setIds(grandparent.id, [parent.id]);

    const section = await loadListingParentsSection(parent);

    const reason = t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
    expect(section.offeredUnder).toEqual([grandparent]);
    expect(
      section.candidates.map(({ ineligibleReason, listing }) => ({
        id: listing.id,
        ineligibleReason,
      })),
    ).toEqual([
      { id: candidate.id, ineligibleReason: reason },
      { id: grandparent.id, ineligibleReason: reason },
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
    const [grandparent, parent, child] = await createNamedListings(
      "Grandparent",
      "Parent",
      "Child",
    );

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
    const [parent, child, grandchild] = await createNamedListings(
      "Parent",
      "Child",
      "Grandchild",
    );
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
