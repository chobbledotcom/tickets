import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  getEmbeddableTicketResponse,
  getHeader,
  mockFormRequest,
  mockRequest,
  testRequiresAuth,
} from "#test-utils";

/** Post invalid embed hosts and assert a 302 redirect with error flash */
async function postInvalidEmbedHosts(
  hosts: string,
  expectedError: string,
): Promise<void> {
  const { response } = await adminFormPost("/admin/settings/embed-hosts", {
    embed_hosts: hosts,
  });
  await expectFlashRedirect(
    "/admin/settings?form=settings-embed-hosts#settings-embed-hosts",
    expect.stringContaining(expectedError),
    false,
  )(response);
}

/** Post embed hosts form and assert a 302 redirect with expected flash message */
async function postEmbedHostsExpectRedirect(
  fields: Record<string, string>,
  expectedMessage: string,
): Promise<void> {
  const { response } = await adminFormPost(
    "/admin/settings/embed-hosts",
    fields,
  );
  await expectFlashRedirect(
    "/admin/settings?form=settings-embed-hosts#settings-embed-hosts",
    expectedMessage,
  )(response);
}

/** Create an embeddable listing and return its ticket page CSP header */
async function getTicketCsp(setupEmbedHosts?: string): Promise<string> {
  if (setupEmbedHosts !== undefined) {
    await settings.update.embedHosts(setupEmbedHosts);
  }
  const response = await getEmbeddableTicketResponse();
  return getHeader(response, "content-security-policy");
}

describeWithEnv("server (embed hosts)", { db: true }, () => {
  describe("GET /admin/settings (embed hosts section)", () => {
    test("shows embed hosts section on settings page", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(
        response,
        200,
        "External sites allowed to use embeds and order buttons",
        "embed_hosts",
      );
    });

    test("shows current embed hosts value when configured", async () => {
      await settings.update.embedHosts("example.com, *.mysite.org");
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "example.com, *.mysite.org");
    });

    test("shows empty field when no embed hosts configured", async () => {
      const { response } = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, 'value=""');
    });
  });

  describe("POST /admin/settings/embed-hosts", () => {
    testRequiresAuth("/admin/settings/embed-hosts", {
      body: {
        embed_hosts: "example.com",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        csrf_token: "invalid-csrf-token",
        embed_hosts: "example.com",
      });
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("saves valid embed hosts", async () => {
      await postEmbedHostsExpectRedirect(
        { embed_hosts: "example.com, *.mysite.org" },
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
          { csrf_token: csrfToken, embed_hosts: "" },
          cookie,
        ),
      );

      await expectFlashRedirect(
        "/admin/settings?form=settings-embed-hosts#settings-embed-hosts",
        "Embed host restrictions removed",
      )(response);
    });

    test("rejects invalid host pattern", async () => {
      await postInvalidEmbedHosts("example.com, *", "Bare wildcard");
    });

    test("rejects host with protocol", async () => {
      await postInvalidEmbedHosts(
        "https://example.com",
        "Invalid host pattern",
      );
    });

    test("handles missing embed_hosts field gracefully", async () => {
      await postEmbedHostsExpectRedirect({}, "Embed host restrictions removed");
    });

    test("clears embed hosts to empty string when only whitespace", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "   ",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Embed host restrictions removed"),
      );
      expect(settings.embedHosts).toBe("");
    });

    test("rejects bare wildcard embed host pattern", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "*",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Bare wildcard"), false);
    });

    test("normalizes and persists embed hosts to the database", async () => {
      const { response } = await adminFormPost("/admin/settings/embed-hosts", {
        embed_hosts: "Example.com, *.Sub.Example.com",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Allowed embed hosts updated"),
      );
      expect(settings.embedHosts).toBe("example.com, *.sub.example.com");
    });
  });

  describe("CSP frame-ancestors with embed hosts", () => {
    test("ticket page has no frame-ancestors when no embed hosts configured", async () => {
      const csp = await getTicketCsp();
      expect(csp).not.toContain("frame-ancestors");
    });

    test("ticket page has frame-ancestors when embed hosts configured", async () => {
      const csp = await getTicketCsp("example.com, *.mysite.org");
      expect(csp).toContain("frame-ancestors 'self' example.com *.mysite.org");
    });

    test("non-embeddable pages still have frame-ancestors none regardless of embed hosts", async () => {
      await settings.update.embedHosts("example.com");

      const response = await handleRequest(mockRequest("/"));
      const csp = getHeader(response, "content-security-policy");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("example.com");
    });

    test("ticket page has no X-Frame-Options when embed hosts configured", async () => {
      await settings.update.embedHosts("example.com");
      const response = await getEmbeddableTicketResponse();
      expect(response.headers.get("x-frame-options")).toBeNull();
    });
  });
});
