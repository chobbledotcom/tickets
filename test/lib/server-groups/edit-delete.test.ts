import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import { setDemoModeForTest } from "#shared/demo-mode.ts";
import {
  adminFormPost,
  adminGet,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  deleteTestGroup,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  updateTestGroup,
} from "#test-utils";

describeWithEnv("server (admin groups) — edit & delete", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/groups/:id/edit", () => {
    test("shows edit form with pre-filled values", async () => {
      const group = await createTestGroup({
        description: "Editable description",
        name: "Editable",
        slug: "editable",
        termsAndConditions: "Original terms",
      });
      const response = await adminGet(`/admin/groups/${group.id}/edit`);
      // The Edit tab renders the group form pre-filled; the page title is the
      // group name (the old "Edit Group" heading is now the tab label).
      await expectHtmlResponse(
        response,
        200,
        "Editable",
        "editable",
        "Editable description",
        "Original terms",
        'action="/admin/groups/',
      );
    });

    test("shows hidden checkbox checked for hidden group", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Editable",
        slug: "hidden-editable",
      });
      const response = await adminGet(`/admin/groups/${group.id}/edit`);
      const html = await expectHtmlResponse(response, 200, "Hidden Editable");
      expect(html).toContain("checked");
    });

    test("returns 404 for non-existent group", async () => {
      const response = await adminGet("/admin/groups/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/groups/:id/edit", () => {
    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Edit Allow",
        slug: "edit-allow",
      });
      const cookie = await createTestManagerSession("mgr-edit-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/edit`,
          {
            csrf_token: csrfToken,
            name: "Changed",
            slug: "changed",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      // Follow as the manager who made the POST, so the render check verifies
      // the landing page that role actually sees (not the default owner's).
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Group updated",
        true,
        cookie,
      )(response);
    });

    test("updates group", async () => {
      const group = await createTestGroup({ name: "Before", slug: "before" });
      const updated = await updateTestGroup(group.id, {
        name: "After",
        slug: "after",
        termsAndConditions: "Updated terms",
      });
      expect(updated.name).toBe("After");
      expect(updated.slug).toBe("after");
      expect(updated.terms_and_conditions).toBe("Updated terms");
    });

    test("updates group description", async () => {
      const group = await createTestGroup({
        description: "Original description",
        name: "Desc Edit",
        slug: "desc-edit",
      });
      expect(group.description).toBe("Original description");
      const updated = await updateTestGroup(group.id, {
        description: "Updated description",
      });
      expect(updated.description).toBe("Updated description");
      expect(updated.name).toBe("Desc Edit");
    });

    test("updates group hidden flag", async () => {
      const group = await createTestGroup({
        name: "Toggle Hidden",
        slug: "toggle-hidden",
      });
      expect(group.hidden).toBe(false);
      const updated = await updateTestGroup(group.id, { hidden: true });
      expect(updated.hidden).toBe(true);
      const unhidden = await updateTestGroup(group.id, { hidden: false });
      expect(unhidden.hidden).toBe(false);
    });

    test("rejects slug collision with another group", async () => {
      const g1 = await createTestGroup({ name: "One", slug: "one" });
      const g2 = await createTestGroup({ name: "Two", slug: "two" });

      const { response } = await adminFormPost(`/admin/groups/${g2.id}/edit`, {
        name: "Two",
        slug: g1.slug,
        terms_and_conditions: "",
      });
      await expectFlashRedirect(
        `/admin/groups/${g2.id}/edit`,
        expect.stringContaining("Slug is already in use"),
        false,
      )(response);
    });

    test("returns 404 when editing a non-existent group", async () => {
      const { response } = await adminFormPost("/admin/groups/999/edit", {
        name: "Missing",
        slug: "missing",
        terms_and_conditions: "",
      });
      expectStatus(404)(response);
    });
  });

  describe("GET /admin/groups/:id/delete", () => {
    test("shows delete confirmation with listing note", async () => {
      const group = await createTestGroup({
        name: "Delete Me",
        slug: "delete-me",
      });
      const response = await adminGet(`/admin/groups/${group.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Group",
        "Listings in this group will not be deleted",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent group", async () => {
      const response = await adminGet("/admin/groups/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/groups/:id/delete", () => {
    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Delete Allow",
        slug: "delete-allow",
      });
      const cookie = await createTestManagerSession("mgr-delete-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/delete`,
          {
            confirm_identifier: "Delete Allow",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/\/admin\/groups(\?|$)/);
      expectFlash(response, "Group deleted");
    });

    test("rejects deletion when name confirmation is wrong", async () => {
      const group = await createTestGroup({
        name: "Right Name",
        slug: "right-name",
      });
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/delete`,
        {
          confirm_identifier: "Wrong Name",
        },
      );
      await expectFlashRedirect(
        `/admin/groups/${group.id}/delete`,
        expect.stringContaining("Group name does not match"),
        false,
      )(response);
    });

    test("deletes group, resets listings to group_id=0, and does not delete listings", async () => {
      const group = await createTestGroup({
        name: "To Delete",
        slug: "to-delete",
      });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Grouped Listing",
      });
      expect(await getGroupIdsByListingId(listing.id)).toContain(group.id);

      await deleteTestGroup(group.id);

      const { groups } = await import("#shared/db/groups.ts");
      const { getListing } = await import("#shared/db/listings.ts");

      expect(await groups.table.findById(group.id)).toBeNull();
      const existingListing = await getListing(listing.id);
      expect(existingListing).not.toBeNull();
      // Group delete prunes membership rows, leaving the listing ungrouped.
      expect(await getGroupIdsByListingId(listing.id)).toEqual([]);
    });

    test("returns 404 when deleting a non-existent group", async () => {
      const { response } = await adminFormPost("/admin/groups/999/delete", {
        confirm_identifier: "Anything",
      });
      expectStatus(404)(response);
    });

    test("succeeds when group is deleted between load and delete", async () => {
      const group = await createTestGroup({
        name: "Race Group",
        slug: "race-group",
      });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const { groups } = await import("#shared/db/groups.ts");
      const original = groups.table.findById.bind(groups.table);
      let calls = 0;
      const findByIdStub = stub(
        groups.table,
        "findById",
        (...args: Parameters<typeof original>) => {
          calls++;
          return calls === 1 ? original(...args) : Promise.resolve(null);
        },
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/delete`,
            { confirm_identifier: group.name, csrf_token: csrfToken },
            cookie,
          ),
        );
        await expectFlashRedirect("/admin/groups", "Group deleted")(response);
      } finally {
        findByIdStub.restore();
      }
    });
  });
});
