import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  mockFormRequest,
  testRequiresAuth,
  updateTestGroup,
} from "#test-utils";

describeWithEnv("server (admin groups) — list & create", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/groups", () => {
    testRequiresAuth("/admin/groups");

    test("accessible to managers", async () => {
      const response = await awaitTestRequest("/admin/groups", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(200)(response);
    });

    test("shows empty list when no groups exist", async () => {
      const response = await adminGet("/admin/groups");
      await expectHtmlResponse(response, 200, "Groups", "No groups configured");
    });

    test("shows groups in table when present", async () => {
      const group = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });

      const response = await adminGet("/admin/groups");
      // The name links to the group detail page; edit/delete live there now,
      // not inline in the list table.
      await expectHtmlResponse(
        response,
        200,
        "Group One",
        "group-one",
        `/admin/groups/${group.id}">`,
      );
    });
  });

  describe("GET /admin/groups/new", () => {
    testRequiresAuth("/admin/groups/new");

    test("accessible to managers", async () => {
      const response = await awaitTestRequest("/admin/groups/new", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(200)(response);
    });

    test("shows create group form without slug field", async () => {
      const response = await adminGet("/admin/groups/new");
      const html = await expectHtmlResponse(
        response,
        200,
        "Add Group",
        "Group Name",
        "Description (optional)",
        "Terms and Conditions",
      );
      expect(html).not.toContain('name="slug"');
    });
  });

  describe("POST /admin/groups", () => {
    testRequiresAuth("/admin/groups", {
      body: { name: "X" },
      method: "POST",
    });

    test("accessible to managers", async () => {
      const cookie = await createTestManagerSession("mgr-create-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/groups",
          {
            csrf_token: csrfToken,
            name: "Manager Group",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(
        /\/admin\/groups\/\d+(\?|$)/,
      );
      expectFlash(response, "Group created");
    });

    test("creates group with auto-generated slug", async () => {
      const group = await createTestGroup({
        name: "New Group",
        termsAndConditions: "Group terms",
      });
      expect(group.name).toBe("New Group");
      expect(group.slug).toBeTruthy();
      expect(group.slug.length).toBe(5);
      expect(group.terms_and_conditions).toBe("Group terms");
    });

    test("creates group with description", async () => {
      const group = await createTestGroup({
        description: "A fun group of listings",
        name: "Described Group",
      });
      expect(group.name).toBe("Described Group");
      expect(group.description).toBe("A fun group of listings");
    });

    const NAME_IN_USE = "Name is already in use by another listing or group";

    test("rejects a group whose name is used by a listing", async () => {
      await createTestListing({ name: "Clash Name" });
      const { response } = await adminFormPost("/admin/groups", {
        name: "Clash Name",
        terms_and_conditions: "",
      });
      await expectFlashRedirect(
        "/admin/groups/new",
        NAME_IN_USE,
        false,
      )(response);
    });

    test("rejects a group whose name is used by another group", async () => {
      await createTestGroup({ name: "Twin Group" });
      const { response } = await adminFormPost("/admin/groups", {
        name: "Twin Group",
        terms_and_conditions: "",
      });
      await expectFlashRedirect(
        "/admin/groups/new",
        NAME_IN_USE,
        false,
      )(response);
    });

    test("lets a group keep its own name on edit", async () => {
      const group = await createTestGroup({ name: "Renamer" });
      // Re-saving the group under its own name must not trip the uniqueness
      // check against itself.
      const updated = await updateTestGroup(group.id, {
        name: "Renamer",
        slug: group.slug,
      });
      expect(updated.name).toBe("Renamer");
    });

    test("creates group without description defaults to empty string", async () => {
      const group = await createTestGroup({ name: "No Desc Group" });
      expect(group.description).toBe("");
    });

    test("creates group with hidden flag", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Group",
      });
      expect(group.name).toBe("Hidden Group");
      expect(group.hidden).toBe(true);
    });

    test("creates group without hidden flag by default", async () => {
      const group = await createTestGroup({
        name: "Visible Group",
      });
      expect(group.hidden).toBe(false);
    });

    test("creates group and allows slug to be set via edit", async () => {
      const group = await createTestGroup({
        name: "New Group",
        slug: "custom-slug",
        termsAndConditions: "Group terms",
      });
      expect(group.name).toBe("New Group");
      expect(group.slug).toBe("custom-slug");
      expect(group.terms_and_conditions).toBe("Group terms");
    });
  });
});
