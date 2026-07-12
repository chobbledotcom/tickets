// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { icsDiscoveryTag, rssDiscoveryTag } from "#templates/public/shared.tsx";
import { assertPublicHtml, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > terms and contact pages",
  { db: true, triggers: true },
  () => {
    describe("GET /terms", () => {
      test("redirects to admin when public site is disabled", async () => {
        const response = await handleRequest(mockRequest("/terms"));
        expectRedirect(response, /^\/admin\/login$/);
      });

      test("shows terms page when enabled", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.terms("Our terms and conditions.");
        const html = await assertPublicHtml(
          "/terms",
          "Our terms and conditions.",
          "T&amp;Cs",
        );
        // The login footer is a homepage-only affordance (#69).
        expect(html).not.toContain('href="/admin/login"');
      });

      test("returns 404 when terms not configured", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(mockRequest("/terms"));
        expect(response.status).toBe(404);
      });

      test("includes RSS and ICS feed discovery tags", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.terms("Some terms");
        await assertPublicHtml("/terms", rssDiscoveryTag(), icsDiscoveryTag());
      });
    });

    describe("GET /contact", () => {
      test("redirects to admin when public site is disabled", async () => {
        const response = await handleRequest(mockRequest("/contact"));
        expectRedirect(response, /^\/admin\/login$/);
      });

      test("shows contact page when enabled", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.contactPageText("Get in touch with us");
        const html = await assertPublicHtml(
          "/contact",
          "Get in touch with us",
          "Contact",
        );
        // The login footer is a homepage-only affordance (#69).
        expect(html).not.toContain('href="/admin/login"');
      });

      test("returns 404 when contact text not configured", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(mockRequest("/contact"));
        expect(response.status).toBe(404);
      });

      test("renders markdown paragraphs in contact text", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.contactPageText(
          "Phone: 123\n\nAddress: 1 High Street",
        );
        await assertPublicHtml(
          "/contact",
          "<p>Phone: 123</p>",
          "<p>Address: 1 High Street</p>",
        );
      });

      test("returns 404 for non-GET requests to /contact", async () => {
        const response = await handleRequest(
          mockFormRequest("/contact", { name: "Test" }),
        );
        expect(response.status).toBe(404);
      });

      test("includes RSS and ICS feed discovery tags", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.contactPageText("Contact us");
        await assertPublicHtml(
          "/contact",
          rssDiscoveryTag(),
          icsDiscoveryTag(),
        );
      });
    });

    describe("non-GET/POST requests to public pages", () => {
      test("returns 404 for POST to /terms", async () => {
        const response = await handleRequest(
          mockFormRequest("/terms", { name: "Test" }),
        );
        expect(response.status).toBe(404);
      });

      test("returns 404 for PUT to /listings", async () => {
        const response = await handleRequest(
          mockRequest("/listings", { method: "PUT" }),
        );
        expect(response.status).toBe(404);
      });
    });
  },
);
