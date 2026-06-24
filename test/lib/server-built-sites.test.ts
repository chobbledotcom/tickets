import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestBuiltSite,
  deleteTestBuiltSite,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  FLASH_TEST_ID,
  flashCookieHeader,
  testBuiltSite,
  testCookie,
  testRequiresAuth,
  updateTestBuiltSite,
} from "#test-utils";

const builtSitesTestEnv = { db: true, triggers: true };

describeWithEnv("server (admin built sites)", builtSitesTestEnv, () => {
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
      const html = await expectHtmlResponse(
        response,
        200,
        "My Site",
        "https://mysite.b-cdn.net",
        `/admin/built-sites/${site.id}/edit`,
      );
      // The site name links to the edit page; delete moved to that page.
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}/edit">My Site</a>`,
      );
      expect(html).not.toContain(`/admin/built-sites/${site.id}/delete`);
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
        "#shared/db/built-sites.ts"
      );
      await insertBuiltSite(
        "Taken Site",
        "https://taken.b-cdn.net",
        "",
        "",
        true,
      );
      const { getAllBuiltSites } = await import("#shared/db/built-sites.ts");
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

    test("warns when no qualifying renewal tier exists", async () => {
      const { response } = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).toContain("No renewal tier listing is configured");
    });

    test("lists qualifying tiers with units sold from real attendee data", async () => {
      const { createTestListing, bookAttendee } = await import("#test-utils");
      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 100,
        monthsPerUnit: 1,
        name: "Listed Monthly Tier",
        purchaseOnly: true,
        unitPrice: 500,
      });
      // Two bookings on this tier, total quantity = 5.
      await bookAttendee(tier, { quantity: 2 });
      await bookAttendee(tier, { quantity: 3 });

      const { response } = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).toContain("Listed Monthly Tier");
      // Sum of quantities, not the booking count.
      expect(body).toContain(">5<");
      expect(body).not.toContain("No renewal tier listing is configured");
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
      body: {
        bunny_url: "https://test.b-cdn.net",
        name: "Test",
      },
      method: "POST",
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
      await expectFlashRedirect(
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

    test("rejects http, localhost and IP bunny URLs", async () => {
      for (const bunnyUrl of [
        "http://test.b-cdn.net",
        "https://localhost",
        "https://1.1.1.1",
        "https://[::1]/",
      ]) {
        const { response } = await adminFormPost("/admin/built-sites", {
          bunny_url: bunnyUrl,
          name: "Test",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("URL must use https://"),
          false,
        );
      }
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

    test("renders the Secrets and Delete sections", async () => {
      const site = await createTestBuiltSite({
        bunnyScriptId: "8000",
        name: "Sections",
      });
      const { response } = await adminGet(`/admin/built-sites/${site.id}/edit`);
      const html = await expectHtmlResponse(response, 200, "Edit Built Site");
      expect(html).toContain("Secrets");
      expect(html).toContain(`/admin/built-sites/${site.id}/delete`);
      expect(html).toContain("Delete this site");
    });

    test("returns 404 for non-existent built site", async () => {
      const { response } = await adminGet("/admin/built-sites/999/edit");
      expectStatus(404)(response);
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
        bunny_url: "https://updated.b-cdn.net",
        name: "Updated",
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

      const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
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

      const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
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

  describe("nav link", () => {
    test("builds link visible when CAN_BUILD_SITES is true", async () => {
      Deno.env.set("CAN_BUILD_SITES", "true");
      try {
        const { response } = await adminGet("/admin/built-sites");
        const body = await response.text();
        expect(body).toContain("/admin/built-sites");
        // The nav link is labelled "Builds" (the page title stays "Built Sites").
        expect(body).toContain(">Builds<");
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

  describe("update channel", () => {
    test("create form offers the update-channel selector", async () => {
      const { response } = await adminGet("/admin/built-sites/new");
      await expectHtmlResponse(
        response,
        200,
        "Update channel",
        "Release (stable only)",
        "Beta (beta + stable)",
        "Alpha (every release)",
      );
    });

    test("defaults the channel to release when the form omits it", async () => {
      const site = await createTestBuiltSite({ name: "Defaulted" });
      expect(site.updates).toBe("release");
    });

    test("persists a chosen channel on create", async () => {
      const site = await createTestBuiltSite({
        name: "Beta Channel",
        updates: "beta",
      });
      expect(site.updates).toBe("beta");
    });

    test("editing changes the channel", async () => {
      const site = await createTestBuiltSite({ name: "Channel Edit" });
      const updated = await updateTestBuiltSite(site.id, { updates: "alpha" });
      expect(updated.updates).toBe("alpha");
    });

    test("rejects an unknown channel value", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        bunny_url: "https://chan.b-cdn.net",
        name: "Bad Channel",
        updates: "stable",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Update channel must be alpha, beta or release",
        ),
        false,
      );
    });

    test("the fleet list shows each site's channel", async () => {
      await createTestBuiltSite({ name: "Listed Site", updates: "beta" });
      const { response } = await adminGet("/admin/built-sites");
      const html = await expectHtmlResponse(response, 200, "Updates");
      expect(html).toContain("<td>beta</td>");
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
