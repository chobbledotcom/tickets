import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectRedirect,
  installRecordingFetch,
  mockFormRequest,
  mockRequest,
  setTestEnv,
  testCookie,
} from "#test-utils";

const ADMIN_ENV = { ADMIN_EMAIL_ADDRESS: "host@support.test" };

/** Stub fetch so the Resend email endpoint answers; records request bodies. */
const installSupportFetch = (opts: { status?: number } = {}) =>
  installRecordingFetch((url) =>
    url.includes("api.resend.com")
      ? new Response(null, { status: opts.status ?? 200 })
      : null,
  );

/** Configure the email provider so support messages can be delivered. */
const configureEmail = async (): Promise<void> => {
  await settings.update.businessEmail("owner@example.com");
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_test_key");
};

describeWithEnv(
  "server (admin support, enabled)",
  { db: true, env: ADMIN_ENV },
  () => {
    describe("GET /admin/support", () => {
      test("shows the fallback message when SUPPORT_PAGE_TEXT is unset", async () => {
        const restore = setTestEnv({ SUPPORT_PAGE_TEXT: undefined });
        try {
          const response = await adminGet("/admin/support");
          const html = await response.text();
          expect(response.status).toBe(200);
          expect(html).toContain("Your admin hasn't filled in");
          expect(html).toContain("SUPPORT_PAGE_TEXT");
        } finally {
          restore();
        }
      });

      test("renders SUPPORT_PAGE_TEXT as markdown", async () => {
        const restore = setTestEnv({
          SUPPORT_PAGE_TEXT: "# Help Center\\n\\nReach out anytime",
        });
        try {
          const response = await adminGet("/admin/support");
          const html = await response.text();
          expect(html).toContain("<h1>Help Center</h1>");
          expect(html).toContain("Reach out anytime");
          expect(html).not.toContain("strange message");
        } finally {
          restore();
        }
      });

      test("renders no form (and no note) when no business email is set", async () => {
        const response = await adminGet("/admin/support");
        const html = await response.text();
        // The page (support text) still renders, but the form section is empty.
        expect(response.status).toBe(200);
        expect(html).not.toContain('name="message"');
        expect(html).not.toContain('action="/admin/support"');
      });

      test("shows just a message box when a business email is set", async () => {
        await settings.update.businessEmail("owner@example.com");
        const response = await adminGet("/admin/support");
        const html = await response.text();
        expect(html).toContain('action="/admin/support"');
        expect(html).toContain('name="message"');
        // No email field at all: support always sends from the business email.
        expect(html).not.toContain('name="email"');
      });

      test("shows the Support link in the settings sub-nav", async () => {
        const response = await adminGet("/admin/settings");
        const html = await response.text();
        expect(html).toContain('href="/admin/support"');
      });

      test("returns 403 for a non-owner (manager) session", async () => {
        const managerCookie = await createTestManagerSession();
        const response = await awaitTestRequest("/admin/support", {
          cookie: managerCookie,
        });
        expect(response.status).toBe(403);
      });

      test("redirects an unauthenticated visitor to /admin", async () => {
        const response = await handleRequest(mockRequest("/admin/support"));
        expectRedirect(response, "/admin");
      });
    });

    describe("POST /admin/support", () => {
      test("delivers to the host and replies to the site's business email", async () => {
        await configureEmail();
        const mock = installSupportFetch();
        try {
          const { response } = await adminFormPost("/admin/support", {
            message: "Please help me",
          });
          expectRedirect(response, "/admin/support");
          expectFlash(response, "Your message has been sent");
          const emailCall = mock.emailCall();
          expect(emailCall?.body?.to).toEqual(["host@support.test"]);
          expect(emailCall?.body?.reply_to).toBe("owner@example.com");
          expect(String(emailCall?.body?.subject)).toContain(
            "Support message from Chobble Tickets site",
          );
        } finally {
          mock.restore();
        }
      });

      test("ignores any submitted email and sends from the business email", async () => {
        await configureEmail();
        const mock = installSupportFetch();
        try {
          await adminFormPost("/admin/support", {
            email: "attacker@evil.test",
            message: "Please help me",
          });
          expect(mock.emailCall()?.body?.reply_to).toBe("owner@example.com");
        } finally {
          mock.restore();
        }
      });

      test("records the submission and nags on the next visit", async () => {
        await configureEmail();
        const mock = installSupportFetch();
        try {
          await adminFormPost("/admin/support", { message: "Please help me" });
          expect(settings.supportFormLastSubmitted).not.toBe("");
          const response = await adminGet("/admin/support");
          const html = await response.text();
          // Notice sits inside the form with the time value in bold.
          expect(html).toContain("You last submitted this form <strong>");
          // ...and it's between the message box and the submit button.
          const body = html.slice(html.indexOf('name="message"'));
          expect(body.indexOf("You last submitted this form")).toBeLessThan(
            body.indexOf("Send message"),
          );
        } finally {
          mock.restore();
        }
      });

      test("rejects an empty message", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminFormPost("/admin/support", {
          message: "   ",
        });
        expectRedirect(response, "/admin/support");
        expectFlash(response, "Please enter a message.", false);
      });

      test("rejects a message that exceeds the maximum length", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminFormPost("/admin/support", {
          message: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
        });
        expectRedirect(response, "/admin/support");
        expectFlash(
          response,
          expect.stringContaining("characters or fewer"),
          false,
        );
      });

      test("flashes an error when the message cannot be delivered", async () => {
        await configureEmail();
        const mock = installSupportFetch({ status: 500 });
        try {
          const { response } = await adminFormPost("/admin/support", {
            message: "Please help me",
          });
          expectRedirect(response, "/admin/support");
          expectFlash(
            response,
            expect.stringContaining("could not be sent"),
            false,
          );
        } finally {
          mock.restore();
        }
      });

      test("404s when the form is not active (no business email)", async () => {
        const { response } = await adminFormPost("/admin/support", {
          message: "Help",
        });
        expect(response.status).toBe(404);
      });

      test("requires a CSRF token", async () => {
        const cookie = await testCookie();
        const response = await handleRequest(
          mockFormRequest("/admin/support", { message: "Help" }, cookie),
        );
        expect(response.status).toBe(403);
        await expect(response.text()).resolves.toContain("Invalid CSRF token");
      });

      test("is forbidden for a non-owner (manager) session", async () => {
        const managerCookie = await createTestManagerSession();
        const response = await awaitTestRequest("/admin/support", {
          cookie: managerCookie,
          data: { message: "Help" },
          method: "POST",
        });
        expect(response.status).toBe(403);
      });
    });
  },
);

describeWithEnv("server (admin support, disabled)", { db: true }, () => {
  test("GET 404s when ADMIN_EMAIL_ADDRESS is unset", async () => {
    const response = await adminGet("/admin/support");
    expect(response.status).toBe(404);
  });

  test("POST 404s when ADMIN_EMAIL_ADDRESS is unset", async () => {
    const { response } = await adminFormPost("/admin/support", {
      message: "Help",
    });
    expect(response.status).toBe(404);
  });

  test("hides the Support link in the settings sub-nav", async () => {
    const response = await adminGet("/admin/settings");
    const html = await response.text();
    expect(html).not.toContain('href="/admin/support"');
  });
});
