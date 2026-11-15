import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlash, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";
import { makeParent } from "#test-utils/parents.ts";
import {
  adminFormPost,
  adminGet,
  getGroupActionForm,
} from "#test-utils/session.ts";
import { testStatus } from "#test-utils/status-tests.ts";

const getDeactivateForm = getGroupActionForm("deactivate");

/** POST the confirmation form for `group`, whose identifier names it, and
 *  return the response once the redirect status holds. Both the success and the
 *  refusal redirect, so callers assert the destination. */
const postDeactivate = async (group: {
  id: number;
  name: string;
}): Promise<Response> => {
  const { response } = await adminFormPost(
    `/admin/groups/${group.id}/deactivate`,
    { confirm_identifier: group.name },
  );
  expectStatus(302)(response);
  return response;
};

describeWithEnv("Group actions — deactivate", { db: true }, () => {
  describe("GET /admin/groups/:id/deactivate", () => {
    // Not-found boundary — a story cannot reach this path (it sets up a real
    // group first), so it stays as a direct technical contract.
    testStatus(404, {
      "returns 404 when the group does not exist": () =>
        adminGet("/admin/groups/999999/deactivate"),
    });

    test("renders the confirmation form with singular listing count", async () => {
      const { group } = await createGroupWithListings("Solo Deact", ["Only"]);

      const html = await getDeactivateForm(group.id);

      assertStringIncludes(html, "deactivate 1 active listing");
      assert(!html.includes("deactivate 1 active listings"));
    });

    test("renders the confirmation form with plural listing count", async () => {
      const { group } = await createGroupWithListings("Multi Deact", [
        "A",
        "B",
      ]);

      const html = await getDeactivateForm(group.id);

      assertStringIncludes(html, "deactivate 2 active listings");
    });
  });

  describe("POST /admin/groups/:id/deactivate", () => {
    test("deactivates every listing in the group and redirects to the group page on success", async () => {
      // Pins the success branch for the coverage gate: `setGroupListingsActive`
      // runs, the 302 redirect to the group page is returned, and every member
      // is inactive.
      const { group, listings } = await createGroupWithListings("Shutdown", [
        "A",
        "B",
      ]);

      const response = await postDeactivate(group);

      assertStringIncludes(
        response.headers.get("location") ?? "",
        `/admin/groups/${group.id}`,
      );
      // The success flash and the activity row both name the action and the
      // member count.
      expectFlash(response, "Group deactivated (x2 listings)");
      assertArrayIncludes(await activityMessages(), [
        "Group 'Shutdown' deactivated (x2 listings)",
      ]);
      for (const listing of listings) {
        expect((await getListingWithCount(listing.id))?.active).toBe(false);
      }
    });

    test("rejects deactivating a group that holds the only rescuing page of a child add-on, leaving every listing active", async () => {
      // Pins the orphan-prevention guard: a child-scoped opt-in add-on is
      // reachable only via a rescuing page in the group, so a bulk deactivate
      // would orphan it. The guard must block the whole batch before any UPDATE.
      const { group, listings } = await createGroupWithListings(
        "Rescue Group",
        ["Rescuing page", "Sibling"],
      );
      const { child } = await makeParent({
        children: [{ name: "Add-on" }],
        parent: { name: "Base unit" },
      });
      await optInAddOnForListings("Child-scoped extra", [
        child.id,
        listings[0]!.id,
      ]);

      const response = await postDeactivate(group);

      assertStringIncludes(
        response.headers.get("location") ?? "",
        `/admin/groups/${group.id}/deactivate`,
      );
      // No listing was deactivated — the batch was blocked entirely.
      for (const listing of listings) {
        expect((await getListingWithCount(listing.id))?.active).toBe(true);
      }
    });
  });
});
