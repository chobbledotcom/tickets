import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  updateTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";
import type { Group } from "#types";

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
      const html = await expectHtmlResponse(response, 200, "Groups");
      assertStringIncludes(html, "<p>No groups configured.</p>");
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
      assert(!html.includes('name="slug"'));
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
            csrfToken,
            name: "Manager Group",
            termsAndConditions: "",
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

    /** Group creates that differ only in their overrides and stored fields. */
    const createCases: {
      title: string;
      input: Parameters<typeof createTestGroup>[0];
      stored: Partial<Group>;
      slugLength?: number;
    }[] = [
      {
        input: { name: "New Group", termsAndConditions: "Group terms" },
        // A generated slug is five random characters.
        slugLength: 5,
        stored: { name: "New Group", termsAndConditions: "Group terms" },
        title: "creates group with auto-generated slug",
      },
      {
        input: {
          description: "A fun group of listings",
          name: "Described Group",
        },
        stored: {
          description: "A fun group of listings",
          name: "Described Group",
        },
        title: "creates group with description",
      },
      {
        input: { name: "No Desc Group" },
        stored: { description: "", name: "No Desc Group" },
        title: "creates group without description defaults to empty string",
      },
      {
        input: { hidden: true, name: "Hidden Group" },
        stored: { hidden: true, name: "Hidden Group" },
        title: "creates group with hidden flag",
      },
      {
        input: { name: "Visible Group" },
        stored: { hidden: false, name: "Visible Group" },
        title: "creates group without hidden flag by default",
      },
      {
        input: {
          name: "New Group",
          slug: "custom-slug",
          termsAndConditions: "Group terms",
        },
        stored: {
          name: "New Group",
          slug: "custom-slug",
          termsAndConditions: "Group terms",
        },
        title: "creates group and allows slug to be set via edit",
      },
    ];

    for (const { title, input, stored, slugLength } of createCases) {
      test(title, async () => {
        const group = await createTestGroup(input);
        expect(group).toMatchObject(stored);
        if (slugLength !== undefined) {
          expect(group.slug.length).toBe(slugLength);
        }
      });
    }

    const NAME_IN_USE = "Name is already in use by another listing or group";

    /** Each refusal: the row that already holds the name, and the name. */
    const nameClashCases: readonly [
      title: string,
      seed: () => Promise<unknown>,
      name: string,
    ][] = [
      [
        "rejects a group whose name is used by a listing",
        () => createTestListing({ name: "Clash Name" }),
        "Clash Name",
      ],
      [
        "rejects a group whose name is used by another group",
        () => createTestGroup({ name: "Twin Group" }),
        "Twin Group",
      ],
    ];

    for (const [title, seed, name] of nameClashCases) {
      test(title, async () => {
        await seed();
        const { response } = await adminFormPost("/admin/groups", {
          name,
          termsAndConditions: "",
        });
        await expectFlashRedirect(
          "/admin/groups/new",
          NAME_IN_USE,
          false,
        )(response);
      });
    }

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
  });
});
