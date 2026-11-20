/** The admin listing forms keep built-site plans out of every group and
 *  parent/child relation: the create and edit saves refuse, removal stays
 *  possible, and the children form refuses a plan parent. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import {
  expectErrorFlash,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import { postListingEdit } from "#test-utils/listing-parents/helpers.ts";
import { makeParent, postChildren } from "#test-utils/parents.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Save the edit form with assign-built-site switched on and assert the refusal
 *  message. Both gates (a group, or existing children) refuse it the same way. */
const expectEditRefusesPlan = async (
  listingId: number,
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> => {
  const response = await postListingEdit(listingId, {
    assignBuiltSite: true,
    initialSiteMonths: 1,
    ...fields,
  });
  await expectHtmlResponse(response, 400, message);
};

describeWithEnv(
  "server listings > assign_built_site relationships",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("the create form refuses a built-site plan that joins a group", async () => {
      const group = await createTestGroup({ name: "Create Form Group" });

      const { response } = await adminFormPost("/admin/listing", {
        ...baseListingForm,
        assignBuiltSite: "1",
        groupIds: String(group.id),
        initialSiteMonths: "1",
        monthsPerUnit: "0",
        name: "Create Form Plan",
      });

      await expectHtmlResponse(
        response,
        400,
        sitePlanMemberError("Create Form Plan"),
      );
      // The refused create left no listing row behind.
      expect(await getListingWithCount(1)).toBeNull();
    });

    test("the edit form refuses turning on assign-built-site inside a group", async () => {
      const group = await createTestGroup({ name: "Edit Form Group" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Edit Form Candidate",
      });

      await expectEditRefusesPlan(
        listing.id,
        sitePlanMemberError("Edit Form Candidate"),
        { groupId: group.id },
      );
      expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
      expect((await getListingWithCount(listing.id))?.assignBuiltSite).toBe(
        false,
      );
    });

    test("the edit form allows removing the group from a built-site plan", async () => {
      const group = await createTestGroup({ name: "Edit Removal Group" });
      const plan = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        name: "Edit Removal Plan",
      });
      const { setListingGroups } = await import("#db/groups.ts");
      await setListingGroups(plan.id, [group.id]);

      const response = await postListingEdit(plan.id, { groupIds: [] });

      expect(response.status).toBe(302);
      expect(await listingGroups.getIds(plan.id)).toEqual([]);
    });

    test("the edit form refuses turning on assign-built-site while children exist", async () => {
      const { parent } = await makeParent({
        children: [{ name: "Gated Child" }],
        parent: { name: "Gated Parent" },
      });

      await expectEditRefusesPlan(
        parent.id,
        t("listings_table.children_err_parent_site_plan", {
          name: "Gated Parent",
        }),
      );
    });

    test("the children form refuses children for a built-site plan", async () => {
      const plan = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        name: "Childless Plan",
      });
      const child = await createTestListing({ name: "Plan Child" });

      const response = await postChildren(plan.id, [child.id]);

      expectErrorFlash(
        response,
        t("listings_table.children_err_parent_site_plan", {
          name: "Childless Plan",
        }),
      );
      expect(await listingChildren.getIds(plan.id)).toEqual([]);
    });
  },
);
