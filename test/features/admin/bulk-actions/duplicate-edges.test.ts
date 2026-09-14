import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingAttributeOptions } from "#db/attributes.ts";
import { getListingsByGroupId, groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { expectFlash, parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Duplicate a group under a new name, renaming its members so every clone
 * name is unique, and hand back the raw redirect for flash assertions. */
const duplicate = (
  groupId: number,
  newName: string,
  nameFind: string,
  nameReplace: string,
): Promise<{ response: Response }> =>
  adminFormPost(`/admin/groups/${groupId}/bulk-actions/duplicate`, {
    date_find: "",
    date_replace: "",
    name_find: nameFind,
    name_replace: nameReplace,
    new_name: newName,
  });

/** A group member requiring an external child that itself has children: the
 * clone's edge copy to that child is refused ("can't also be a child"), so
 * one such member yields exactly one dropped-edge error. */
const gatedGroupWithExternalNest = async (
  groupName: string,
  parentName: string,
): Promise<void> => {
  const group = await createTestGroup({ name: groupName });
  const parent = await createTestListing({
    groupId: group.id,
    name: parentName,
  });
  const externalChild = await createTestListing({ name: "External child" });
  const grandchild = await createTestListing({ name: "Nested leaf" });
  await listingChildren.setIds(parent.id, [externalChild.id]);
  await listingChildren.setIds(externalChild.id, [grandchild.id]);
};

describeWithEnv(
  "Admin bulk actions — duplicate edge remaps",
  { db: true },
  () => {
    test("warns when one cloned parent's edge copy fails re-validation", async () => {
      // Exactly one dropped edge must still surface the warning flash, not a
      // success — a single failure is not quietly absorbed into plain success.
      const reason = t("listings_table.children_err_child_is_parent", {
        name: "External child",
      });
      await gatedGroupWithExternalNest("Gated", "Gated parent");

      const { response } = await duplicate(
        (await groups.cache.getAll()).find((g) => g.name === "Gated")!.id,
        "Gated Copy",
        "Gated",
        "Cloned",
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        t("listings_table.group_duplicate_children_dropped", {
          reason,
          success: "Duplicated 'Gated' to 'Gated Copy' (x1 listings)",
        }),
        false,
      );
    });

    test("joins several dropped child edges into one warning reason", async () => {
      // Two members each fail their remap; the warning names both reasons,
      // separated, so the operator sees every dropped edge the copy left.
      const first = t("listings_table.children_err_child_is_parent", {
        name: "External child",
      });
      const second = t("listings_table.children_err_child_is_parent", {
        name: "External child two",
      });
      const dropWarning = (reason: string): string =>
        t("listings_table.group_duplicate_children_dropped", {
          reason,
          success: "Duplicated 'Dual gate' to 'Dual gate Copy' (x2 listings)",
        });

      await gatedGroupWithExternalNest("Dual gate", "First gated parent");
      const group = (await groups.cache.getAll()).find(
        (g) => g.name === "Dual gate",
      )!;
      const secondParent = await createTestListing({
        groupId: group.id,
        name: "Second gated parent",
      });
      const secondChild = await createTestListing({
        name: "External child two",
      });
      const secondGrandchild = await createTestListing({
        name: "Nested leaf two",
      });
      await listingChildren.setIds(secondParent.id, [secondChild.id]);
      await listingChildren.setIds(secondChild.id, [secondGrandchild.id]);

      const { response } = await duplicate(
        group.id,
        "Dual gate Copy",
        "gated parent",
        "clone",
      );

      expect(response.status).toBe(302);
      const message = parseFlashCookie(response).error;
      expect([
        dropWarning(`${first}; ${second}`),
        dropWarning(`${second}; ${first}`),
      ]).toContain(message);
    });

    test("copies the source listing's attribute selections onto its clone", async () => {
      // The clone is inserted by raw statement in the big batch, so nothing
      // else would carry its attribute rows — the duplicate flow copies them
      // explicitly after the insert commits.
      const group = await createTestGroup({ name: "Attributed" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Attributed Source",
      });
      const attribute = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
      ]);
      await assignTestAttributeOptions(listing.id, attribute.options);

      await duplicate(group.id, "Attributed Copy", "Source", "Clone");

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Attributed Copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      expect(await listingAttributeOptions.getIds(clone.id)).toEqual([
        attribute.options[0]!.id,
      ]);
      // The source keeps its own selection.
      expect(await listingAttributeOptions.getIds(listing.id)).toEqual([
        attribute.options[0]!.id,
      ]);
    });
  },
);
