import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { updateEmbedHosts } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  expectHtmlResponse,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("server (embed hosts)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/settings (embed hosts section)", () => {
    test("shows embed hosts section on settings page", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(
        response,
        200,
        "Only allow embedding on these hosts",
        "embed_hosts",
      );
    });

    test("shows current embed hosts value when configured", async () => {
      await updateEmbedHosts("example.com, *.mysite.org");
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "example.com, *.mysite.org");
    });

    test("shows empty field when no embed hosts configured", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, 'value=""');
    });
  });

  describe("POST /admin/settings/embed-hosts", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/embed-hosts", {
          embed_hosts: "example.com",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "example.com",
        csrf_token: "invalid-csrf-token",
      });
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves valid embed hosts", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "example.com, *.mysite.org",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Allowed embed hosts updated",
      );
    });

    test("normalizes hosts to lowercase", async () => {
      const { cookie } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "Example.COM, *.MySite.ORG",
      });

      // Verify by checking the settings page
      const settingsResponse = await awaitTestRequest("/admin/settings", {
        cookie,
      });
      const html = await settingsResponse.text();
      expect(html).toContain("example.com, *.mysite.org");
    });

    test("clears embed hosts when empty", async () => {
      // First set some hosts
      const { cookie, csrfToken } = await adminFormPost(
        "/admin/settings/embed-hosts",
        {
          embed_hosts: "example.com",
        },
      );

      // Now clear them
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { embed_hosts: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Embed host restrictions removed",
      );
    });

    test("rejects invalid host pattern", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "example.com, *",
      });

      await expectHtmlResponse(response, 400, "Bare wildcard");
    });

    test("rejects host with protocol", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "https://example.com",
      });

      await expectHtmlResponse(response, 400, "Invalid host pattern");
    });

    test("handles missing embed_hosts field gracefully", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/embed-hosts",
        {},
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain(
        "Embed host restrictions removed",
      );
    });
  });

  describe("CSP frame-ancestors with embed hosts", () => {
    test("ticket page has no frame-ancestors when no embed hosts configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).not.toContain("frame-ancestors");
    });

    test("ticket page has frame-ancestors when embed hosts configured", async () => {
      await updateEmbedHosts("example.com, *.mysite.org");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'self' example.com *.mysite.org");
    });

    test("non-embeddable pages still have frame-ancestors none regardless of embed hosts", async () => {
      await updateEmbedHosts("example.com");

      const response = await handleRequest(mockRequest("/"));
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("example.com");
    });

    test("ticket page has no X-Frame-Options when embed hosts configured", async () => {
      await updateEmbedHosts("example.com");

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.headers.get("x-frame-options")).toBeNull();
    });
  });
});
