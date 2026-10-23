import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  deleteTestBuiltSite,
  updateTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
  testCookie,
} from "#test-utils/session.ts";
import { builtSitesTestEnv } from "./env.ts";

describeWithEnv("server (admin built sites)", builtSitesTestEnv, () => {
  describe("GET /admin/built-sites/:id/:tab", () => {
    testRequiresAuth("/admin/built-sites/1", {
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("shows edit form with pre-filled values", async () => {
      const site = await createTestBuiltSite({
        hostingId: "54321",
        name: "Edit Me",
        siteUrl: "https://editme.b-cdn.net",
      });
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Edit Me",
        "https://editme.b-cdn.net",
        "54321",
      );
    });

    test("renders tab links but only loads the active edit panel", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8000",
        name: "Sections",
      });
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await expectHtmlResponse(response, 200, "Sections");
      assertStringIncludes(html, `/admin/built-sites/${site.id}/secrets`);
      assertStringIncludes(html, `/admin/built-sites/${site.id}/actions`);
      assert(!html.includes("Secrets status is unavailable"));
      assert(!html.includes(`/admin/built-sites/${site.id}/delete`));
    });

    test("loads renewal controls only on the renewal tab", async () => {
      const site = await createTestBuiltSite({ name: "Renewal Tab" });
      const response = await adminGet(`/admin/built-sites/${site.id}/renewal`);
      const html = await expectHtmlResponse(response, 200, "Current deadline");
      assertStringIncludes(html, `/admin/built-sites/${site.id}/bump-deadline`);
      assert(!html.includes('name="site_url"'));
    });

    test("loads delete only on the actions tab", async () => {
      const site = await createTestBuiltSite({ name: "Actions Tab" });
      const response = await adminGet(`/admin/built-sites/${site.id}/actions`);
      const html = await expectHtmlResponse(response, 200, "Delete this site");
      assertStringIncludes(html, `/admin/built-sites/${site.id}/delete`);
      assert(!html.includes('name="site_url"'));
    });

    test("returns 404 for non-existent built site", async () => {
      const response = await adminGet("/admin/built-sites/999");
      expectStatus(404)(response);
    });

    test("returns 404 for an unknown tab", async () => {
      const site = await createTestBuiltSite({ name: "Known Tabs" });
      const response = await adminGet(`/admin/built-sites/${site.id}/unknown`);
      expectStatus(404)(response);
    });

    test("forbids managers from every built-site tab", async () => {
      const site = await createTestBuiltSite({ name: "Owner only" });
      const cookie = await createTestManagerSession();
      const response = await awaitTestRequest(
        `/admin/built-sites/${site.id}/renewal`,
        { cookie },
      );
      expectStatus(403)(response);
    });

    test("loads recoverable secrets failures only on the secrets tab", async () => {
      const site = await createTestBuiltSite({ name: "Secrets status" });
      const response = await adminGet(`/admin/built-sites/${site.id}/secrets`);
      const html = await expectHtmlResponse(response, 200, "no hosting ID");
      assert(!html.includes("Unknown — no read-only database credentials"));
    });

    test("loads update status only on the update tab", async () => {
      const site = await createTestBuiltSite({ name: "Update status" });
      const response = await adminGet(`/admin/built-sites/${site.id}/update`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Unknown — no read-only database credentials",
      );
      assert(
        !html.includes(
          "BUNNY_API_KEY is not configured on this host, so its secrets can't be read",
        ),
      );
    });

    test("shows flashed success and error messages", async () => {
      const site = await createTestBuiltSite({ name: "Flash Site" });
      const cookie = await testCookie();

      const successResponse = await awaitTestRequest(
        `/admin/built-sites/${site.id}/edit?flash=${FLASH_TEST_ID}`,
        { cookie: `${cookie}; ${flashCookieHeader("Deadline bumped")}` },
      );
      await expectHtmlResponse(successResponse, 200, "Deadline bumped");

      const errorResponse = await awaitTestRequest(
        `/admin/built-sites/${site.id}/edit?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "Choose a deadline date",
            false,
          )}`,
        },
      );
      await expectHtmlResponse(errorResponse, 200, "Choose a deadline date");
    });
  });

  describe("POST /admin/built-sites/:id/edit", () => {
    testRequiresAuth("/admin/built-sites/1/edit", {
      body: {
        name: "Updated",
        site_url: "https://updated.b-cdn.net",
      },
      method: "POST",
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("updates built site", async () => {
      const site = await createTestBuiltSite({ name: "Original" });
      const updated = await updateTestBuiltSite(site.id, {
        name: "Updated",
      });
      expect(updated.name).toBe("Updated");
    });

    test("updates bunny script id", async () => {
      const site = await createTestBuiltSite({
        hostingId: "111",
        name: "ScriptIdSite",
      });
      const updated = await updateTestBuiltSite(site.id, {
        hostingId: "999",
      });
      expect(updated.hostingId).toBe("999");
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminFormPost("/admin/built-sites/999/edit", {
        name: "Test",
        site_url: "https://test.b-cdn.net",
      });
      expectStatus(404)(response);
    });

    test("rejects invalid form data on edit", async () => {
      const site = await createTestBuiltSite();
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/edit`,
        {
          name: "",
          site_url: "https://test.b-cdn.net",
        },
      );
      const html = await expectHtmlResponse(
        response,
        400,
        "Site name is required",
        "https://test.b-cdn.net",
      );
      assertStringIncludes(html, 'aria-current="page"');
      assertStringIncludes(html, `href="/admin/built-sites/${site.id}/edit"`);
      assert(!html.includes("Secrets status is unavailable"));
    });

    test("shows read-only status without edit or action controls", async () => {
      const site = await createTestBuiltSite({ name: "Read-only site" });
      using _readOnly = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await expectHtmlResponse(response, 200, "Current deadline");
      assert(!html.includes(`/admin/built-sites/${site.id}/edit`));
      assert(!html.includes(`/admin/built-sites/${site.id}/actions`));
      assert(!html.includes(`/admin/built-sites/${site.id}/bump-deadline`));
      assertStringIncludes(html, `/admin/built-sites/${site.id}/secrets`);
    });
  });

  describe("GET /admin/built-sites/:id/delete", () => {
    testRequiresAuth("/admin/built-sites/1/delete", {
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("shows delete confirmation page", async () => {
      const site = await createTestBuiltSite({ name: "Delete Me" });
      const response = await adminGet(`/admin/built-sites/${site.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Built Site",
        "Delete Me",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent built site", async () => {
      const response = await adminGet("/admin/built-sites/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/built-sites/:id/delete", () => {
    testRequiresAuth("/admin/built-sites/1/delete", {
      body: {
        confirm_identifier: "Test Site",
      },
      method: "POST",
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("deletes built site with correct name confirmation", async () => {
      const site = await createTestBuiltSite({ name: "To Delete" });
      await deleteTestBuiltSite(site.id);

      const { builtSitesCrudTable } = await import("#db/built-sites.ts");
      const found = await builtSitesCrudTable.read.one({ id: site.id });
      expect(found).toBeNull();
    });

    test("rejects deletion with wrong name", async () => {
      const site = await createTestBuiltSite({ name: "Keep Me" });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/delete`,
        {
          confirm_identifier: "Wrong Name",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Built site name does not match"),
        false,
      );

      const { builtSitesCrudTable } = await import("#db/built-sites.ts");
      const found = await builtSitesCrudTable.read.one({ id: site.id });
      expect(found).not.toBeNull();
    });

    test("a list filter reads back only the sites that exist", async () => {
      const site = await createTestBuiltSite({ name: "Lookup Site" });
      const { builtSitesCrudTable } = await import("#db/built-sites.ts");
      expect(
        (await builtSitesCrudTable.read.many({ id: [site.id, 999_999] })).map(
          (row) => row.id,
        ),
      ).toEqual([site.id]);
    });

    test("name confirmation is case-insensitive", async () => {
      const site = await createTestBuiltSite({ name: "Case Test" });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/delete`,
        {
          confirm_identifier: "case test",
        },
      );
      await expectFlashRedirect(
        "/admin/built-sites",
        "Built site deleted",
      )(response);
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminFormPost(
        "/admin/built-sites/999/delete",
        {
          confirm_identifier: "Test",
        },
      );
      expectStatus(404)(response);
    });
  });
});
