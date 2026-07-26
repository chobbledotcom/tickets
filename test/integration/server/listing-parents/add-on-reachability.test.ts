import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  apiCreateListing,
  groupScopedAddOn,
  linkedParentChild,
  linkGroupAddOn,
  postListingEdit,
} from "#test/test-utils/listing-parents/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  linkModifierGroup,
  optInAddOnForListings,
} from "#test-utils/modifiers.ts";
import { postChildren } from "#test-utils/parents.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv(
  "server > listing parents > add-on reachability",
  { db: true },
  () => {
    test("admin API blocks a child whose add-on only it can reach", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await optInAddOnForListings("Child-only extra", [child.id]);
      await assertJson(
        apiRequest(`/api/admin/listings/${parent.id}`, {
          body: { child_listing_ids: [child.id] },
          method: "PUT",
        }),
        400,
      );
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });

    test("blocks a child whose opt-in add-on only it can reach", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await optInAddOnForListings("Child-only extra", [child.id]);
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });

    test("allows a bookable_alone child whose opt-in add-on only it can reach", async () => {
      // A child that can be booked by itself keeps its own booking page, so an
      // add-on scoped only to it is still reachable — the edge is not a dead end.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        bookableAlone: true,
        name: "Solo Widget",
      });
      await optInAddOnForListings("Child-only extra", [child.id]);
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    });

    test("allows a child whose add-on is also scoped to the parent", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await optInAddOnForListings("Shared extra", [parent.id, child.id]);
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    });

    test("allows a child whose add-on is scoped to a group containing the parent", async () => {
      // The add-on is groups-scoped to a group holding both the parent and the
      // child, so it resolves to listing ids including the parent — still
      // reachable via the parent's page ids, so the edge is allowed.
      const { parent, child } = await groupScopedAddOn();
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    });

    test("blocks a child whose add-on is reachable only via a parent's group sibling", async () => {
      // The direct /ticket/<parent> page loads add-ons from only the parent's
      // own id, never its group siblings — so an add-on scoped to {child,
      // sibling} but not the parent is a dead end and the edge must be blocked.
      const group = await createTestGroup({ name: "Bundle" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Base unit",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        name: "Sibling",
      });
      const child = await createTestListing({ name: "Add-on" });
      await optInAddOnForListings("Sibling-only extra", [sibling.id, child.id]);
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });

    test("a listing save moving a parent out of a group orphans a group-scoped add-on (rejected)", async () => {
      // The group-scoped add-on resolves to {parent, child} and loads on the
      // parent's page, so the edge is valid. Moving the PARENT out of the group
      // makes the add-on resolve to {child} only: reachable solely through the
      // suppressed child, which can't offer it. The listing save must be rejected
      // against the would-be group_id, leaving the parent in its group.
      const { group, parent, child } = await groupScopedAddOn();
      await postChildren(parent.id, [child.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);

      const res = await postListingEdit(parent.id, { groupId: 0 });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Group extra");
      expect(await listingGroups.getIds(parent.id)).toEqual([group.id]);
    });

    test("a listing save that keeps a group-scoped add-on reachable is allowed", async () => {
      // Moving the parent to ANOTHER group the add-on is also scoped to keeps the
      // add-on reachable from the parent's page, so the save is allowed (the guard
      // is a reachability test, not a blanket group-change block).
      const fromGroup = await createTestGroup({ name: "From" });
      const toGroup = await createTestGroup({ name: "To" });
      const parent = await createTestListing({
        groupId: fromGroup.id,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: fromGroup.id,
        name: "Add-on",
      });
      // The add-on covers both groups, so it reaches the parent in either one.
      const modifierId = await linkGroupAddOn(fromGroup.id);
      await linkModifierGroup(modifierId, toGroup.id);
      await postChildren(parent.id, [child.id]);

      await updateTestListing(parent.id, { groupId: toGroup.id });
      expect(await listingGroups.getIds(parent.id)).toEqual([toGroup.id]);
    });

    test("saving a CHILD into a group that orphans its add-on is rejected", async () => {
      // The edge is checked from the child's side too: a child C under parent P
      // (P is the page). An add-on is group-scoped to group G, and P is NOT in G.
      // While C is ungrouped the add-on doesn't reach C, so the edge is valid.
      // Moving C INTO G makes the add-on resolve to {C, ...}: reachable only via
      // the suppressed child C, never via P's page — the save must be rejected
      // (the child-role branch of the edge check).
      const group = await createTestGroup({ name: "Bundle" });
      const { parent, child } = await linkedParentChild();
      await linkGroupAddOn(group.id);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);

      const res = await postListingEdit(child.id, { groupId: group.id });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Group extra");
      expect(await listingGroups.getIds(child.id)).toEqual([]);
    });

    test("validateListingInput rejects an orphaning group change with an omitted groupId", async () => {
      // The admin JSON API may omit group_id; validateListingInput then sees
      // groupId undefined and defaults the would-be group to 0 (no group). A
      // parent whose group-scoped add-on only resolves to it via its group is
      // orphaned by dropping to no group, so the (defaulted) check still blocks.
      const { validateListingInput } = await import(
        "#shared/listings-actions.ts"
      );
      const { listingsTable } = await import("#shared/db/listings/records.ts");
      const { parent, child } = await groupScopedAddOn();
      await postChildren(parent.id, [child.id]);

      const row = (await getListingWithCount(parent.id))!;
      // Omit groupIds entirely (undefined) — validateListingInput defaults it to
      // "no groups", which still orphans the group-scoped add-on.
      const input = listingsTable.rowToInput(row, [
        "created",
      ]) as import("#shared/catalog-fields/fields.ts").ListingInput;
      const error = await validateListingInput(input, parent.id);
      expect(error).toContain("Group extra");
    });

    test("API create of a parent in the same group as the child's group-scoped add-on is accepted", async () => {
      // The child carries a GROUP-scoped opt-in add-on. Creating a NEW parent in
      // that same group must be ACCEPTED: the add-on is reachable from the new
      // parent's own page once it joins the group. The old code validated against
      // the placeholder id (never in the group) and wrongly rejected this.
      const group = await createTestGroup({ name: "Bundle" });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      await linkGroupAddOn(group.id);

      const newId = await apiCreateListing({
        child_listing_ids: [child.id],
        group_ids: [group.id],
        listing_type: "standard",
        max_attendees: 10,
        name: "New base unit",
      });
      expect(await listingChildren.getIds(newId)).toEqual([child.id]);
      expect(await listingGroups.getIds(newId)).toEqual([group.id]);
    });

    test("API update moving a parent's group so the add-on becomes unreachable is rejected", async () => {
      // The add-on is group-scoped to the parent+child's group, so it's reachable
      // from the parent's page. A single PUT that BOTH moves the parent to another
      // group AND (re)sets the child edge must be judged against the would-be
      // group: after the move the add-on resolves to {child} only, a dead end —
      // so the update must be rejected and nothing persisted.
      const otherGroup = await createTestGroup({ name: "Elsewhere" });
      const { group, parent, child } = await groupScopedAddOn();
      await postChildren(parent.id, [child.id]);

      await assertJson(
        apiRequest(`/api/admin/listings/${parent.id}`, {
          body: { child_listing_ids: [child.id], group_ids: [otherGroup.id] },
          method: "PUT",
        }),
        400,
        (json) => {
          expect(json.error).toContain("Group extra");
        },
      );
      // Neither the group move nor the edge change is partially applied; the
      // existing edge is preserved and the parent stays in its group.
      expect(await listingGroups.getIds(parent.id)).toEqual([group.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    });
  },
);
