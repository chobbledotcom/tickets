import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  getHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getEmbeddableTicketResponse } from "#test-utils/db-helpers/misc.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { expectFormValueRefused } from "#test-utils/settings-refusal.ts";

/** Post invalid embed hosts and assert a 302 redirect with error flash */
async function expectInvalidEmbedHostsRefused(
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
async function expectEmbedHostsRedirect(
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

/** Post the embed hosts form, then pin the 302 reply and the stored value. */
async function expectEmbedHostsStored(
  fields: Record<string, string>,
  expected: { message: string; stored: string },
): Promise<void> {
  const { response } = await adminFormPost(
    "/admin/settings/embed-hosts",
    fields,
  );
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining(expected.message));
  expect(settings.embedHosts).toBe(expected.stored);
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
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(
        response,
        200,
        "External sites allowed to use embeds and order buttons",
        "embed_hosts",
      );
    });

    test("shows current embed hosts value when configured", async () => {
      await settings.update.embedHosts("example.com, *.mysite.org");
      const response = await adminGet("/admin/settings");
      await expectHtmlResponse(response, 200, "example.com, *.mysite.org");
    });

    test("shows empty field when no embed hosts configured", async () => {
      const response = await adminGet("/admin/settings");
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
      await expectEmbedHostsRedirect(
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
      assertStringIncludes(html, "example.com, *.mysite.org");
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
      expect(settings.embedHosts).toBe("");
    });

    /** Rows the form must refuse: the hosts posted and the error flash. */
    const rejectedHostCases = [
      {
        error: "Bare wildcard",
        hosts: "example.com, *",
        name: "rejects invalid host pattern",
      },
      {
        error: "Invalid host pattern",
        hosts: "https://example.com",
        name: "rejects host with protocol",
      },
    ];

    for (const { error, hosts, name } of rejectedHostCases) {
      test(name, async () => {
        await expectInvalidEmbedHostsRefused(hosts, error);
      });
    }

    test("handles missing embed_hosts field gracefully", async () => {
      await expectEmbedHostsRedirect({}, "Embed host restrictions removed");
    });

    test("clears embed hosts to empty string when only whitespace", async () => {
      await expectEmbedHostsStored(
        { embed_hosts: "   " },
        { message: "Embed host restrictions removed", stored: "" },
      );
    });

    test("rejects bare wildcard embed host pattern", async () => {
      await expectFormValueRefused(
        {
          fields: { embed_hosts: "*" },
          flash: "Bare wildcard",
          path: "/admin/settings/embed-hosts",
          stored: () => settings.embedHosts,
        },
        "",
      );
    });

    test("normalizes and persists embed hosts to the database", async () => {
      await expectEmbedHostsStored(
        { embed_hosts: "Example.com, *.Sub.Example.com" },
        {
          message: "Allowed embed hosts updated",
          stored: "example.com, *.sub.example.com",
        },
      );
    });
  });

  describe("CSP frame-ancestors with embed hosts", () => {
    test("ticket page has no frame-ancestors when no embed hosts configured", async () => {
      const csp = await getTicketCsp();
      assert(!csp.includes("frame-ancestors"));
    });

    test("ticket page has frame-ancestors when embed hosts configured", async () => {
      const csp = await getTicketCsp("example.com, *.mysite.org");
      assertStringIncludes(
        csp,
        "frame-ancestors 'self' example.com *.mysite.org",
      );
    });

    test("non-embeddable pages still have frame-ancestors none regardless of embed hosts", async () => {
      await settings.update.embedHosts("example.com");

      const response = await handleRequest(mockRequest("/"));
      const csp = getHeader(response, "content-security-policy");
      assertStringIncludes(csp, "frame-ancestors 'none'");
      assert(!csp.includes("example.com"));
    });

    test("ticket page has no X-Frame-Options when embed hosts configured", async () => {
      await settings.update.embedHosts("example.com");
      const response = await getEmbeddableTicketResponse();
      expect(response.headers.get("x-frame-options")).toBeNull();
    });
  });
});
