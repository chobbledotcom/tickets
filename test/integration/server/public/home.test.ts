// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { icsDiscoveryTag, rssDiscoveryTag } from "#templates/public/shared.tsx";
import { assertPublicHtml, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv("server public > home", { db: true, triggers: true }, () => {
  describe("GET /", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("shows public homepage when enabled", async () => {
      await enablePublicSite();
      await assertPublicHtml("/", "Home", "/admin/login");
    });

    test("shows website title on homepage", async () => {
      await enablePublicSite();
      await settings.update.websiteTitle("My Cool Site");
      await assertPublicHtml("/", "My Cool Site");
    });

    test("shows homepage text when configured", async () => {
      await enablePublicSite();
      await settings.update.homepageText("Welcome to our listings!");
      await assertPublicHtml("/", "Welcome to our listings!");
    });

    test("shows no content message when homepage text not set", async () => {
      await enablePublicSite();
      await assertPublicHtml("/", "No content.");
    });

    test("shows public nav links", async () => {
      await enablePublicSite();
      await settings.update.terms("Some terms");
      await settings.update.contactPageText("Contact us");
      await assertPublicHtml(
        "/",
        'href="/"',
        'href="/listings"',
        'href="/terms"',
        'href="/contact"',
      );
    });

    test("hides terms and contact nav links when pages are empty", async () => {
      await enablePublicSite();
      const html = await assertPublicHtml("/", 'href="/"', 'href="/listings"');
      expect(html).not.toContain('href="/terms"');
      expect(html).not.toContain('href="/contact"');
    });

    test("shows login link styled as footer", async () => {
      await enablePublicSite();
      await assertPublicHtml(
        "/",
        'class="homepage-footer"',
        'href="/admin/login"',
        "Login",
      );
    });

    test("returns 404 for non-GET requests to /", async () => {
      const response = await handleRequest(mockRequest("/", { method: "PUT" }));
      expect(response.status).toBe(404);
    });

    test("redirects legacy /events to listings when public site is enabled", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/events"));
      expectRedirect(response, /^\/listings$/);
    });

    test("does not redirect legacy /events when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/events"));
      expect(response.status).toBe(404);
    });

    test("renders markdown paragraphs in homepage text", async () => {
      await enablePublicSite();
      await settings.update.homepageText("Line one\n\nLine two");
      await assertPublicHtml("/", "<p>Line one</p>", "<p>Line two</p>");
    });

    test("includes RSS and ICS feed discovery tags", async () => {
      await enablePublicSite();
      await assertPublicHtml("/", rssDiscoveryTag(), icsDiscoveryTag());
    });
  });
});
