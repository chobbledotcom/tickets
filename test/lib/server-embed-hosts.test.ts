import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { updateEmbedHosts } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  expectHtmlResponse,
  getEmbeddableTicketResponse,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Decode redirect location from response, normalizing URL encoding */
function decodedLocation(response: Response): string {
  return decodeURIComponent(
    response.headers.get("location")!.replaceAll("+", " "),
  );
}

/** Post invalid embed hosts and assert a 400 error with expected message */
async function postInvalidEmbedHosts(
  hosts: string,
  expectedError: string,
): Promise<void> {
  const { response } = await adminFormPost("/admin/settings/embed-hosts", {
    embed_hosts: hosts,
  });
  await expectHtmlResponse(response, 400, expectedError);
}

/** Post embed hosts form and assert a 302 redirect containing the expected message */
async function postEmbedHostsExpectRedirect(
  fields: Record<string, string>,
  expectedMessage: string,
): Promise<void> {
  const { response } = await adminFormPost(
    "/admin/settings/embed-hosts",
    fields,
  );
  expect(response.status).toBe(302);
  expect(decodedLocation(response)).toContain(expectedMessage);
}

/** Create an embeddable event and return its ticket page CSP header */
async function getTicketCsp(setupEmbedHosts?: string): Promise<string> {
  if (setupEmbedHosts !== undefined) {
    await updateEmbedHosts(setupEmbedHosts);
  }
  const response = await getEmbeddableTicketResponse();
  return response.headers.get("content-security-policy")!;
}

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
          { embed_hosts: "", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(decodedLocation(response)).toContain(
        "Embed host restrictions removed",
      );
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
      await updateEmbedHosts("example.com");

      const response = await handleRequest(mockRequest("/"));
      const csp = response.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("example.com");
    });

    test("ticket page has no X-Frame-Options when embed hosts configured", async () => {
      await updateEmbedHosts("example.com");
      const response = await getEmbeddableTicketResponse();
      expect(response.headers.get("x-frame-options")).toBeNull();
    });
  });
});
