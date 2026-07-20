import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectActivityLogShows,
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

const builtSitesTestEnv = {
  db: true,
  env: { CAN_BUILD_SITES: "true" },
  triggers: true,
};

describeWithEnv("server (admin built sites)", builtSitesTestEnv, () => {
  describe("GET /admin/built-sites", () => {
    testRequiresAuth("/admin/built-sites");

    test("shows empty built sites list", async () => {
      const response = await adminGet("/admin/built-sites");
      await expectHtmlResponse(
        response,
        200,
        "Built Sites",
        "No built sites recorded",
      );
    });

    test("shows built sites in table when present", async () => {
      const site = await createTestBuiltSite({
        name: "My Site",
        siteUrl: "https://mysite.b-cdn.net",
      });
      const response = await adminGet("/admin/built-sites");
      const html = await expectHtmlResponse(
        response,
        200,
        "My Site",
        "https://mysite.b-cdn.net",
        `/admin/built-sites/${site.id}`,
      );
      expect(html).toContain(
        `href="/admin/built-sites/${site.id}">My Site</a>`,
      );
      expect(html).not.toContain(`/admin/built-sites/${site.id}/delete`);
    });

    test("shows Not assignable status for default sites", async () => {
      await createTestBuiltSite({ name: "Default Site" });
      const response = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200, "Not assignable");
    });

    test("shows Available status for assignable sites", async () => {
      await createTestBuiltSite({ assignable: true, name: "Ready Site" });
      const response = await adminGet("/admin/built-sites");
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
      const { builtSites } = await import("#shared/db/built-sites.ts");
      const sites = await builtSites.getAll();
      await assignBuiltSite(sites[0]!.id, 42, 7);

      const response = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200, "Assigned (attendee #42)");
    });

    test("displays script IDs separated by pipes below the table", async () => {
      await createTestBuiltSite({
        hostingId: "1111",
        name: "Site 1",
      });
      await createTestBuiltSite({
        hostingId: "222",
        name: "Site 2",
      });
      await createTestBuiltSite({
        hostingId: "",
        name: "Site 3",
      });
      const response = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).toContain("1111|222");
      expect(body).not.toContain("1111|222|");
    });

    test("displays empty string when no script IDs present", async () => {
      await createTestBuiltSite({
        hostingId: "",
        name: "No Script",
      });
      const response = await adminGet("/admin/built-sites");
      await expectHtmlResponse(response, 200);
    });

    test("warns when no qualifying renewal tier exists", async () => {
      const response = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).toContain("No renewal tier listing is configured");
    });

    test("lists qualifying tiers with units sold from real attendee data", async () => {
      const { bookAttendee } = await import(
        "#test-utils/db-helpers/attendee-payments.ts"
      );
      const { createTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
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

      const response = await adminGet("/admin/built-sites");
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
      const response = await adminGet("/admin/built-sites/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Built Site",
        "Site Name",
        "Site URL",
        "Database URL",
        "Database Token",
        "Hosting ID",
      );
    });
  });

  describe("POST /admin/built-sites", () => {
    testRequiresAuth("/admin/built-sites", {
      body: {
        name: "Test",
        site_url: "https://test.b-cdn.net",
      },
      method: "POST",
    });

    test("creates built site and redirects", async () => {
      const site = await createTestBuiltSite({
        name: "New Site",
        siteUrl: "https://new.b-cdn.net",
      });
      expect(site.name).toBe("New Site");
      expect(site.siteUrl).toBe("https://new.b-cdn.net");
    });

    test("creates built site without db credentials", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        name: "No DB Site",
        site_url: "https://nodb.b-cdn.net",
      });
      await expectFlashRedirect(
        "/admin/built-sites/1",
        expect.stringContaining("created"),
      )(response);
    });

    test("rejects missing name", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        name: "",
        site_url: "https://test.b-cdn.net",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Site Name is required"),
        false,
      );
    });

    test("rejects missing site_url", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        name: "Test",
        site_url: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Site URL is required"),
        false,
      );
    });

    test("rejects http, localhost and IP bunny URLs", async () => {
      for (const siteUrl of [
        "http://test.b-cdn.net",
        "https://localhost",
        "https://1.1.1.1",
        "https://[::1]/",
      ]) {
        const { response } = await adminFormPost("/admin/built-sites", {
          name: "Test",
          site_url: siteUrl,
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("URL must use https://"),
          false,
        );
      }
    });

    test("stores deno hosting_provider when submitted", async () => {
      const site = await createTestBuiltSite({
        hostingProvider: "deno",
        name: "Deno Hosted",
        siteUrl: "https://app.deno.dev",
      });
      expect(site.hostingProvider).toBe("deno");
    });

    test("stores turso db_provider when submitted", async () => {
      const site = await createTestBuiltSite({
        dbProvider: "turso",
        name: "Turso DB Site",
        siteUrl: "https://turso-site.b-cdn.net",
      });
      expect(site.dbProvider).toBe("turso");
    });
  });

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
      expect(html).toContain(`/admin/built-sites/${site.id}/secrets`);
      expect(html).toContain(`/admin/built-sites/${site.id}/actions`);
      expect(html).not.toContain("Secrets status is unavailable");
      expect(html).not.toContain(`/admin/built-sites/${site.id}/delete`);
    });

    test("loads renewal controls only on the renewal tab", async () => {
      const site = await createTestBuiltSite({ name: "Renewal Tab" });
      const response = await adminGet(`/admin/built-sites/${site.id}/renewal`);
      const html = await expectHtmlResponse(response, 200, "Current deadline");
      expect(html).toContain(`/admin/built-sites/${site.id}/bump-deadline`);
      expect(html).not.toContain('name="site_url"');
    });

    test("loads delete only on the actions tab", async () => {
      const site = await createTestBuiltSite({ name: "Actions Tab" });
      const response = await adminGet(`/admin/built-sites/${site.id}/actions`);
      const html = await expectHtmlResponse(response, 200, "Delete this site");
      expect(html).toContain(`/admin/built-sites/${site.id}/delete`);
      expect(html).not.toContain('name="site_url"');
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
      expect(html).not.toContain("Unknown — no read-only database credentials");
    });

    test("loads update status only on the update tab", async () => {
      const site = await createTestBuiltSite({ name: "Update status" });
      const response = await adminGet(`/admin/built-sites/${site.id}/update`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Unknown — no read-only database credentials",
      );
      expect(html).not.toContain(
        "BUNNY_API_KEY is not configured on this host, so its secrets can't be read",
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
        "Site Name is required",
        "https://test.b-cdn.net",
      );
      expect(html).toContain('aria-current="page"');
      expect(html).toContain(`href="/admin/built-sites/${site.id}/edit"`);
      expect(html).not.toContain("Secrets status is unavailable");
    });

    test("shows read-only status without edit or action controls", async () => {
      const site = await createTestBuiltSite({ name: "Read-only site" });
      using _readOnly = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });
      const response = await adminGet(`/admin/built-sites/${site.id}`);
      const html = await expectHtmlResponse(response, 200, "Current deadline");
      expect(html).not.toContain(`/admin/built-sites/${site.id}/edit`);
      expect(html).not.toContain(`/admin/built-sites/${site.id}/actions`);
      expect(html).not.toContain(`/admin/built-sites/${site.id}/bump-deadline`);
      expect(html).toContain(`/admin/built-sites/${site.id}/secrets`);
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
        const response = await adminGet("/admin/built-sites");
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
      const response = await adminGet("/admin/built-sites");
      const body = await response.text();
      expect(body).not.toContain('href="/admin/built-sites"');
    });
  });

  describe("activity logging", () => {
    test("logs built site creation", async () => {
      await createTestBuiltSite({ name: "Logged Site" });
      await expectActivityLogShows("Logged Site", "created");
    });

    test("logs built site update", async () => {
      const site = await createTestBuiltSite({ name: "Before Update" });
      await updateTestBuiltSite(site.id, { name: "Updated Site" });
      await expectActivityLogShows("Updated Site", "updated");
    });

    test("logs built site deletion", async () => {
      const site = await createTestBuiltSite({ name: "Deleted Site" });
      await deleteTestBuiltSite(site.id);
      await expectActivityLogShows("Deleted Site", "deleted");
    });
  });

  describe("update channel", () => {
    test("create form offers the update-channel selector", async () => {
      const response = await adminGet("/admin/built-sites/new");
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

    test("an edit that omits the updates field preserves the channel", async () => {
      const site = await createTestBuiltSite({
        name: "Keep Beta",
        updates: "beta",
      });
      // A POST with the older field set (no `updates`) must not silently reset
      // the channel to the default — the route only carries a recognised value.
      const { response } = await adminFormPost(
        `/admin/built-sites/${site.id}/edit`,
        { name: "Keep Beta Renamed", site_url: site.siteUrl },
      );
      expect(response.status).toBe(302);
      const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
      const updated = await builtSitesCrudTable.findById(site.id);
      expect(updated!.name).toBe("Keep Beta Renamed");
      expect(updated!.updates).toBe("beta");
    });

    test("rejects an unknown channel value", async () => {
      const { response } = await adminFormPost("/admin/built-sites", {
        name: "Bad Channel",
        site_url: "https://chan.b-cdn.net",
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
      const response = await adminGet("/admin/built-sites");
      const html = await expectHtmlResponse(response, 200, "Updates");
      expect(html).toContain("<td>beta</td>");
    });
  });

  describe("edit/delete error fallback", () => {
    test("returns 404 when built site not found during edit error", async () => {
      const { response } = await adminFormPost("/admin/built-sites/999/edit", {
        name: "",
        site_url: "https://test.b-cdn.net",
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

// The built-sites section is hidden from the nav when CAN_BUILD_SITES is off,
// so none of its routes should be reachable either — a page for a disabled
// feature must not serve.
describeWithEnv(
  "built-sites routes are hidden when CAN_BUILD_SITES is off",
  { db: true, env: { CAN_BUILD_SITES: undefined } },
  () => {
    test("every built-sites route 404s while the feature is off", async () => {
      // createTestBuiltSite flips the flag on only for its own request, so the
      // site exists but the section is still off for the checks below.
      const site = await createTestBuiltSite({ name: "Hidden" });
      const getPaths = [
        "/admin/built-sites",
        "/admin/built-sites/new",
        `/admin/built-sites/${site.id}/edit`,
        `/admin/built-sites/${site.id}/delete`,
      ];
      for (const path of getPaths) {
        expectStatus(404)(await adminGet(path));
      }
      // A POST action (create and a per-site action) is gated too.
      const { response: created } = await adminFormPost("/admin/built-sites", {
        name: "Nope",
        site_url: "https://nope.b-cdn.net",
      });
      expectStatus(404)(created);
      const { response: updated } = await adminFormPost(
        `/admin/built-sites/${site.id}/update`,
        {},
      );
      expectStatus(404)(updated);
    });
  },
);
