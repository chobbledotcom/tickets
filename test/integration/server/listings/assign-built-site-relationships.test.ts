/** The admin listing forms keep built-site plans out of every group and
 *  parent/child relation: the create and edit saves refuse, removal stays
 *  possible, and the children form refuses a plan parent. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups.ts";
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
import { postListingEdit } from "#test-utils/listing-parents/helpers.ts";
import { postChildren } from "#test-utils/parents.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv(
  "server listings > assign_built_site relationships",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("the create form refuses a built-site plan that joins a group", async () => {
      const group = await createTestGroup({ name: "Create Form Group" });

      const { response } = await adminFormPost("/admin/listing", {
        assign_built_site: "1",
        group_ids: String(group.id),
        initial_site_months: "1",
        max_attendees: "50",
        max_quantity: "1",
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

      const response = await postListingEdit(listing.id, {
        assignBuiltSite: true,
        groupId: group.id,
        initialSiteMonths: 1,
      });

      await expectHtmlResponse(
        response,
        400,
        sitePlanMemberError("Edit Form Candidate"),
      );
      expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
      expect((await getListingWithCount(listing.id))?.assign_built_site).toBe(
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
      const parent = await createTestListing({ name: "Gated Parent" });
      const child = await createTestListing({ name: "Gated Child" });
      await listingChildren.setIds(parent.id, [child.id]);

      const response = await postListingEdit(parent.id, {
        assignBuiltSite: true,
        initialSiteMonths: 1,
      });

      await expectHtmlResponse(
        response,
        400,
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
