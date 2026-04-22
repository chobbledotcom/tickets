import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

import { handleRequest as _handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  createTestBuiltSite,
  deleteTestBuiltSite,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
  mockFormRequest as _mockFormRequest,
  mockRequest as _mockRequest,
  testBuiltSite,
  testRequiresAuth,
  updateTestBuiltSite,
} from "#test-utils";

describeWithEnv("server (admin built sites)", { db: true }, () => {
  describe("GET /admin/built-sites", () => {
    testRequiresAuth("/admin/built-sites");

    test("shows empty built sites list", async () => {
      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(
        response,
        200,
        "Built Sites",
        "No built sites recorded",
      );
    });

    test("shows built sites in table when present", async () => {
      const site = await createTestBuiltSite({
        bunnyUrl: "https://mysite.b-cdn.net",
        name: "My Site",
      });
      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(
        response,
        200,
        "My Site",
        "https://mysite.b-cdn.net",
        `/admin/built-sites/${site.id}/edit`,
        `/admin/built-sites/${site.id}/delete`,
      );
    });

    test("shows Not assignable status for default sites", async () => {
      await createTestBuiltSite({ name: "Default Site" });
      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200, "Not assignable");
    });

    test("shows Available status for assignable sites", async () => {
      await createTestBuiltSite({ assignable: true, name: "Ready Site" });
      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200, "Available");
    });

    test("shows Assigned status for assigned sites", async () => {
      const { insertBuiltSite, assignBuiltSite } = await import(
        "#lib/db/built-sites.ts"
      );
      await insertBuiltSite(
        "Taken Site",
        "https://taken.b-cdn.net",
        "",
        "",
        true,
      );
      const { getAllBuiltSites } = await import("#lib/db/built-sites.ts");
      const sites = await getAllBuiltSites();
      await assignBuiltSite(sites[0]!.id, 42, 7);

      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200, "Assigned (attendee #42)");
    });

    test("displays script IDs separated by pipes below the table", async () => {
      await createTestBuiltSite({
        bunnyScriptId: "1111",
        name: "Site 1",
      });
      await createTestBuiltSite({
        bunnyScriptId: "222",
        name: "Site 2",
      });
      await createTestBuiltSite({
        bunnyScriptId: "",
        name: "Site 3",
      });
      const { response } = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).toContain("1111|222");
      expect(body).not.toContain("1111|222|");
    });

    test("displays empty string when no script IDs present", async () => {
      await createTestBuiltSite({
        bunnyScriptId: "",
        name: "No Script",
      });
      const { response } = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200);
    });
  });

  describe("GET /admin/built-sites/new", () => {
    testRequiresAuth("/admin/built-sites/new");

    test("shows create built site form", async () => {
      const { response } = await adminGet("/admin/built-sites/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Built Site",
        "Site Name",
        "Bunny URL",
        "Database URL",
        "Database Token",
        "Bunny Script ID",
      );
    });
  });

  describe("POST /admin/built-sites", () => {
    testRequiresAuth("/admin/built-sites", {
      method: "POST",
      body: {
        bunny_url: "https://test.b-cdn.net",
        name: "Test",
      },
    });

    test("creates built site and redirects", async () => {
      const site = await createTestBuiltSite({
        bunnyUrl: "https://new.b-cdn.net",
        name: "New Site",
      });
      expect(site.name).toBe("New Site");
      expect(site.bunnyUrl).toBe("https://new.b-cdn.net");
    });

    test("creates built site without db credentials", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        bunny_url: "https://nodb.b-cdn.net",
        name: "No DB Site",
      });
      expectRedirectWithFlash(
        "/admin/built-sites",
        expect.stringContaining("created"),
      )(response);
    });

    test("rejects missing name", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        bunny_url: "https://test.b-cdn.net",
        name: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Site Name is required"),
        false,
      );
    });

    test("rejects missing bunny_url", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        bunny_url: "",
        name: "Test",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Bunny URL is required"),
        false,
      );
    });
  });

  describe("GET /admin/built-sites/:id/edit", () => {
    testRequiresAuth("/admin/built-sites/1/edit", {
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("shows edit form with pre-filled values", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "54321",
        bunnyUrl: "https://editme.b-cdn.net",
        name: "Edit Me",
      });
      const { response } = await adminGet(`/admin/built-sites/${site.id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Edit Built Site",
        "Edit Me",
        "https://editme.b-cdn.net",
        "54321",
      );
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminGet("/admin/built-sites/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/built-sites/:id/edit", () => {
    testRequiresAuth("/admin/built-sites/1/edit", {
      method: "POST",
      body: {
        bunny_url: "https://updated.b-cdn.net",
        name: "Updated",
      },
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
        bunnyScriptId: "111",
        name: "ScriptIdSite",
      });
      const updated = await updateTestBuiltSite(site.id, {
        bunnyScriptId: "999",
      });
      expect(updated.bunnyScriptId).toBe("999");
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminFormPost("/admin/built-sites/999/edit", {
        bunny_url: "https://test.b-cdn.net",
        name: "Test",
      });
      expectStatus(404)(response);
    });

    test("rejects invalid form data on edit", async () => {
      const site = await createTestBuiltSite();
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/edit`,
        {
          bunny_url: "https://test.b-cdn.net",
          name: "",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Site Name is required"),
        false,
      );
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
      const { response } = await adminGet(
        `/admin/built-sites/${site.id}/delete`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Delete Built Site",
        "Delete Me",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminGet("/admin/built-sites/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/built-sites/:id/delete", () => {
    testRequiresAuth("/admin/built-sites/1/delete", {
      method: "POST",
      body: {
        confirm_identifier: "Test Site",
      },
      setup: async () => {
        await createTestBuiltSite();
      },
    });

    test("deletes built site with correct name confirmation", async () => {
      const site = await createTestBuiltSite({ name: "To Delete" });
      await deleteTestBuiltSite(site.id);

      const { builtSitesCrudTable } = await import("#lib/db/built-sites.ts");
      const found = await builtSitesCrudTable.findById(site.id);
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

      const { builtSitesCrudTable } = await import("#lib/db/built-sites.ts");
      const found = await builtSitesCrudTable.findById(site.id);
      expect(found).not.toBeNull();
    });

    test("name confirmation is case-insensitive", async () => {
      const site = await createTestBuiltSite({ name: "Case Test" });
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/delete`,
        {
          confirm_identifier: "case test",
        },
      );
      expectRedirectWithFlash(
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

  describe("nav link", () => {
    test("built sites link visible when CAN_BUILD_SITES is true", async () => {
      Deno.env.set("CAN_BUILD_SITES", "true");
      try {
        const { response } = await adminGet("/admin/built-sites");
        const body = await response.text();
        expect(body).toContain("/admin/built-sites");
        expect(body).toContain("Built Sites");
      } finally {
        Deno.env.delete("CAN_BUILD_SITES");
      }
    });

    test("built sites link hidden when CAN_BUILD_SITES is not set", async () => {
      Deno.env.delete("CAN_BUILD_SITES");
      const { response } = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).not.toContain('href="/admin/built-sites"');
    });
  });

  describe("activity logging", () => {
    test("logs built site creation", async () => {
      await createTestBuiltSite({ name: "Logged Site" });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged Site");
      expect(body).toContain("created");
    });

    test("logs built site update", async () => {
      const site = await createTestBuiltSite({ name: "Before Update" });
      await updateTestBuiltSite(site.id, { name: "After Update" });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("After Update");
      expect(body).toContain("updated");
    });

    test("logs built site deletion", async () => {
      const site = await createTestBuiltSite({ name: "Deleted Site" });
      await deleteTestBuiltSite(site.id);
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Site");
      expect(body).toContain("deleted");
    });
  });

  describe("builtSiteToFieldValues", () => {
    test("returns empty defaults when no site provided", async () => {
      const { builtSiteToFieldValues } = await import(
        "#templates/admin/built-sites.tsx"
      );
      const values = builtSiteToFieldValues();
      expect(values.name).toBe("");
      expect(values.bunny_url).toBe("");
      expect(values.db_url).toBe("");
      expect(values.db_token).toBe("");
      expect(values.bunny_script_id).toBe("");
      expect(values.assignable).toBe("");
    });

    test("returns site values when site provided", async () => {
      const { builtSiteToFieldValues } = await import(
        "#templates/admin/built-sites.tsx"
      );
      const site = testBuiltSite({
        bunnyScriptId: "42",
        bunnyUrl: "https://test.b-cdn.net",
        dbToken: "tok123",
        dbUrl: "libsql://test.turso.io",
        name: "Test",
      });
      const values = builtSiteToFieldValues(site);
      expect(values.name).toBe("Test");
      expect(values.bunny_url).toBe("https://test.b-cdn.net");
      expect(values.db_url).toBe("libsql://test.turso.io");
      expect(values.db_token).toBe("tok123");
      expect(values.bunny_script_id).toBe("42");
      expect(values.assignable).toBe("");
    });

    test("returns assignable=1 for assignable site", async () => {
      const { builtSiteToFieldValues } = await import(
        "#templates/admin/built-sites.tsx"
      );
      const site = testBuiltSite({ assignable: true });
      const values = builtSiteToFieldValues(site);
      expect(values.assignable).toBe("1");
    });
  });

  describe("edit/delete error fallback", () => {
    test("returns 404 when built site not found during edit error", async () => {
      const { response } = await adminFormPost("/admin/built-sites/999/edit", {
        bunny_url: "https://test.b-cdn.net",
        name: "",
      });
      expectStatus(404)(response);
    });

    test("returns 404 when built site not found during delete error", async () => {
      const { response } = await adminFormPost(
        "/admin/built-sites/999/delete",
        {
          confirm_identifier: "Wrong",
        },
      );
      expectStatus(404)(response);
    });
  });
});
