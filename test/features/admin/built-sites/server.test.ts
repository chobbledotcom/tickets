import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectActivityLogShows } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  deleteTestBuiltSite,
  updateTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { builtSitesTestEnv } from "./env.ts";

describeWithEnv("server (admin built sites)", builtSitesTestEnv, () => {
  describe("GET /admin/built-sites", () => {
    testRequiresAuth("/admin/built-sites");

    test("shows empty built sites list", async () => {
      const response = await adminGet("/admin/built-sites");
      await expectHtmlResponse(
        response,
        200,
        "Built sites",
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
      assertStringIncludes(
        html,
        `href="/admin/built-sites/${site.id}">My Site</a>`,
      );
      assert(!html.includes(`/admin/built-sites/${site.id}/delete`));
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
      const site = await createTestBuiltSite({
        assignable: true,
        name: "Taken Site",
        siteUrl: "https://taken.b-cdn.net",
      });
      const { takePooledSiteForBuyer } = await import(
        "#db/built-sites/claims.ts"
      );
      await takePooledSiteForBuyer([site], 42, [7], 7);

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
      assertStringIncludes(body, "1111|222");
      assert(!body.includes("1111|222|"));
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
      assertStringIncludes(body, "No renewal tier listing is configured");
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
      assertStringIncludes(body, "Listed Monthly Tier");
      // Sum of quantities, not the booking count.
      assertStringIncludes(body, ">5<");
      assert(!body.includes("No renewal tier listing is configured"));
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
        "Site name",
        "Site URL",
        "Database URL",
        "Database token",
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
        expect.stringContaining("Site name is required"),
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

  describe("nav link", () => {
    test("builds link visible when CAN_BUILD_SITES is true", async () => {
      Deno.env.set("CAN_BUILD_SITES", "true");
      try {
        const response = await adminGet("/admin/built-sites");
        const body = await response.text();
        assertStringIncludes(body, "/admin/built-sites");
        // The nav link is labelled "Builds" (the page title stays "Built sites").
        assertStringIncludes(body, ">Builds<");
      } finally {
        Deno.env.delete("CAN_BUILD_SITES");
      }
    });

    test("built sites link hidden when CAN_BUILD_SITES is not set", async () => {
      Deno.env.delete("CAN_BUILD_SITES");
      const response = await adminGet("/admin/built-sites");
      const body = await response.text();
      assert(!body.includes('href="/admin/built-sites"'));
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
      const { builtSitesCrudTable } = await import("#db/built-sites.ts");
      const updated = await builtSitesCrudTable.read.one({ id: site.id });
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
      assertStringIncludes(html, "<td>beta</td>");
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
