import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { updateEmbedHosts } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  loginAsAdmin,
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
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Only allow embedding on these hosts");
      expect(html).toContain("embed_hosts");
    });

    test("shows current embed hosts value when configured", async () => {
      await updateEmbedHosts("example.com, *.mysite.org");
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("example.com, *.mysite.org");
    });

    test("shows empty field when no embed hosts configured", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value=""');
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
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "example.com",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("saves valid embed hosts", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "example.com, *.mysite.org",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Allowed embed hosts updated");
    });

    test("normalizes hosts to lowercase", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "Example.COM, *.MySite.ORG",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Verify by checking the settings page
      const settingsResponse = await awaitTestRequest("/admin/settings", { cookie });
      const html = await settingsResponse.text();
      expect(html).toContain("example.com, *.mysite.org");
    });

    test("clears embed hosts when empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // First set some hosts
      await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Now clear them
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Embed host restrictions removed");
    });

    test("rejects invalid host pattern", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "example.com, *",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Bare wildcard");
    });

    test("rejects host with protocol", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          {
            embed_hosts: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid host pattern");
    });

    test("handles missing embed_hosts field gracefully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/embed-hosts",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Embed host restrictions removed");
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
