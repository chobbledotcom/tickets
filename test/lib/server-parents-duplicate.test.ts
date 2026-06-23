import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { getAllGroups, getListingsByGroupId } from "#shared/db/groups.ts";
import { getChildIds } from "#shared/db/listing-parents.ts";
import {
  adminFormPost,
  baseListingForm,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  duplicateTestListing,
  expectFlashRedirect,
  getTestSession,
  insertModifier,
  linkModifierListing,
  mockMultipartRequest,
  patchModifier,
} from "#test-utils";

/** Set a parent's required children directly (mirrors the admin children form). */
const setChildren = async (
  parentId: number,
  childIds: number[],
): Promise<void> => {
  const { setChildIds } = await import("#shared/db/listing-parents.ts");
  await setChildIds(parentId, childIds);
};

/** Duplicate a single listing via the real admin create flow, returning the raw
 * redirect Response (so its flash can be asserted) and the new copy. Mirrors
 * `duplicateTestListing` but keeps the response instead of swallowing it. */
const duplicateListingResponse = async (
  sourceId: number,
  name: string,
): Promise<{ response: Response; copy: { id: number } }> => {
  const { csrfToken, cookie } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const response = await handleRequest(
    mockMultipartRequest(
      "/admin/listing",
      {
        ...baseListingForm,
        csrf_token: csrfToken,
        duplicated_from: String(sourceId),
        name,
      },
      cookie,
    ),
  );
  const { getAllListings } = await import("#shared/db/listings.ts");
  const copy = (await getAllListings()).find((l) => l.name === name)!;
  return { copy, response };
};

/** An active opt-in add-on scoped to exactly the given listings. */
const optInAddOnScopedTo = async (
  name: string,
  listingIds: number[],
): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, {
    active: 1,
    scope: "listings",
    trigger: "optional",
  });
  for (const id of listingIds) await linkModifierListing(modifier.id, id);
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

    test("duplicating a parent whose child carries a {parent,child}-scoped opt-in add-on warns and does not silently copy a gateless standalone (Fix 1)", async () => {
      // The child has an active opt-in add-on scoped to {originalParent, child}
      // (valid originally — reachable from the original parent's page). On the
      // COPY the add-on is reachable only through the original parent and the
      // (suppressed) child — a dead end from the new parent — so re-validation
      // fails. The fix surfaces a WARNING flash and does NOT write the edge,
      // instead of silently reporting success while leaving a gateless bookable
      // copy.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildren(parent.id, [child.id]);
      await optInAddOnScopedTo("Reachable extra", [parent.id, child.id]);

      const { response, copy } = await duplicateListingResponse(
        parent.id,
        "Base copy with stranded addon",
      );

      // The copy's required-child gate was NOT silently created (would-be
      // gateless standalone is instead flagged, not hidden).
      expect(await getChildIds(copy.id)).toEqual([]);
      // The operator is warned (a non-success flash), not told "created":
      // the create success prefix is suffixed with the dropped-children caveat.
      const reason = t("listings_table.children_err_child_addon", {
        addon: "Reachable extra",
        name: "Add-on",
      });
      const warning = t("listings_table.duplicate_children_dropped", {
        reason,
      });
      const expectedMessage = `${t("success.listing_created")} but: ${warning}`;
      await expectFlashRedirect("/admin", expectedMessage, false)(response);
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

    test("group duplicate remaps an incoming edge from a parent outside the group (Fix 2)", async () => {
      // Fix 2: when a cloned member is a CHILD whose parent lives OUTSIDE the
      // group, the incoming `outsideParent -> clonedChild` edge must be
      // recreated, so the clone stays a child (never standalone-bookable) — the
      // one-cloned-endpoint rule keeps the original opposite endpoint.
      const group = await createTestGroup({ name: "Child only" });
      const outsideParent = await createTestListing({ name: "Outside parent" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Inside child",
      });
      await setChildren(outsideParent.id, [child.id]);

      const copies = await duplicateGroup(group.id, "Child only copy");

      const childCopy = copies.find((l) => l.name === "Inside child")!;
      // The outside parent now gates BOTH the original child and its clone.
      expect((await getChildIds(outsideParent.id)).sort()).toEqual(
        [child.id, childCopy.id].sort(),
      );
      // The clone is itself a child (in getChildListingIds), so its standalone
      // /ticket page 404s rather than booking standalone.
      const { getChildListingIds } = await import(
        "#shared/db/listing-parents.ts"
      );
      expect((await getChildListingIds([childCopy.id])).has(childCopy.id)).toBe(
        true,
      );
      // The clone is not itself a parent (no children of its own).
      expect(await getChildIds(childCopy.id)).toEqual([]);
    });

    test("a member-only-child group's cloned child 404s on its own ticket page (Fix 2)", async () => {
      // End-to-end consequence of Fix 2: the cloned child is a child, so its
      // standalone /ticket/<clonedChild> page must 404 (a booking can never start
      // from a child) instead of letting it be booked standalone.
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({ name: "Outside-parent bundle" });
      const outsideParent = await createTestListing({ name: "External base" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Bundled add-on",
      });
      await setChildren(outsideParent.id, [child.id]);

      const copies = await duplicateGroup(group.id, "Outside-parent bundle 2");
      const childCopy = copies.find((l) => l.name === "Bundled add-on")!;

      const { handleRequest } = await import("#routes");
      const { mockRequest } = await import("#test-utils");
      const response = await handleRequest(
        mockRequest(`/ticket/${childCopy.slug}`),
      );
      response.body?.cancel();
      expect(response.status).toBe(404);
    });
  },
);
