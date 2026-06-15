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
  mockFormRequest,
  mockRequest,
  setTestEnv,
  testCookie,
} from "#test-utils";

const ADMIN_ENV = { ADMIN_EMAIL_ADDRESS: "host@support.test" };

/** Stub fetch so the Resend email endpoint answers; records request bodies. */
const installSupportFetch = (opts: { status?: number } = {}) => {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body;
    calls.push({ body: typeof raw === "string" ? JSON.parse(raw) : null, url });
    if (url.includes("api.resend.com")) {
      return Promise.resolve(
        new Response(null, { status: opts.status ?? 200 }),
      );
    }
    return original(input, init);
  }) as typeof globalThis.fetch;
  return {
    emailCall: () => calls.find((c) => c.url.includes("api.resend.com")),
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

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
          const { response } = await adminGet("/admin/support");
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
          const { response } = await adminGet("/admin/support");
          const html = await response.text();
          expect(html).toContain("<h1>Help Center</h1>");
          expect(html).toContain("Reach out anytime");
          expect(html).not.toContain("strange message");
        } finally {
          restore();
        }
      });

      test("omits the form and explains when no business email is set", async () => {
        const { response } = await adminGet("/admin/support");
        const html = await response.text();
        expect(html).not.toContain('name="message"');
        expect(html).toContain("Set a business email");
      });

      test("shows the message form when a business email is set", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminGet("/admin/support");
        const html = await response.text();
        expect(html).toContain('action="/admin/support"');
        expect(html).toContain('name="email"');
        expect(html).toContain('name="message"');
      });

      test("shows the Support link in the admin nav", async () => {
        const { response } = await adminGet("/admin/");
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
      test("delivers to the admin address and flashes success", async () => {
        await configureEmail();
        const mock = installSupportFetch();
        try {
          const { response } = await adminFormPost("/admin/support", {
            email: "me@external.test",
            message: "Please help me",
          });
          expectRedirect(response, "/admin/support");
          expectFlash(response, "Your message has been sent");
          const emailCall = mock.emailCall();
          expect(emailCall?.body?.to).toEqual(["host@support.test"]);
          expect(emailCall?.body?.reply_to).toBe("me@external.test");
          expect(String(emailCall?.body?.subject)).toContain(
            "Support message from Chobble Tickets site",
          );
        } finally {
          mock.restore();
        }
      });

      test("records the submission and nags on the next visit", async () => {
        await configureEmail();
        const mock = installSupportFetch();
        try {
          await adminFormPost("/admin/support", {
            email: "me@external.test",
            message: "Please help me",
          });
          expect(settings.supportFormLastSubmitted).not.toBe("");
          const { response } = await adminGet("/admin/support");
          const html = await response.text();
          expect(html).toContain("You last submitted this form");
        } finally {
          mock.restore();
        }
      });

      test("rejects an invalid email", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminFormPost("/admin/support", {
          email: "not-an-email",
          message: "Help",
        });
        expectRedirect(response, "/admin/support");
        expectFlash(response, "Please enter a valid email address.", false);
      });

      test("rejects an empty message", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminFormPost("/admin/support", {
          email: "owner@example.com",
          message: "   ",
        });
        expectRedirect(response, "/admin/support");
        expectFlash(response, "Please enter a message.", false);
      });

      test("rejects a message that exceeds the maximum length", async () => {
        await settings.update.businessEmail("owner@example.com");
        const { response } = await adminFormPost("/admin/support", {
          email: "owner@example.com",
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
            email: "me@external.test",
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
          email: "me@external.test",
          message: "Help",
        });
        expect(response.status).toBe(404);
      });

      test("requires a CSRF token", async () => {
        const cookie = await testCookie();
        const response = await handleRequest(
          mockFormRequest(
            "/admin/support",
            { email: "me@external.test", message: "Help" },
            cookie,
          ),
        );
        expect(response.status).toBe(403);
        await expect(response.text()).resolves.toContain("Invalid CSRF token");
      });

      test("is forbidden for a non-owner (manager) session", async () => {
        const managerCookie = await createTestManagerSession();
        const response = await awaitTestRequest("/admin/support", {
          cookie: managerCookie,
          data: { email: "me@external.test", message: "Help" },
          method: "POST",
        });
        expect(response.status).toBe(403);
      });
    });
  },
);

describeWithEnv("server (admin support, disabled)", { db: true }, () => {
  test("GET 404s when ADMIN_EMAIL_ADDRESS is unset", async () => {
    const { response } = await adminGet("/admin/support");
    expect(response.status).toBe(404);
  });

  test("POST 404s when ADMIN_EMAIL_ADDRESS is unset", async () => {
    const { response } = await adminFormPost("/admin/support", {
      email: "me@external.test",
      message: "Help",
    });
    expect(response.status).toBe(404);
  });

  test("hides the Support link in the admin nav", async () => {
    const { response } = await adminGet("/admin/");
    const html = await response.text();
    expect(html).not.toContain('href="/admin/support"');
  });
});
