/**
 * Tests for the admin Support page routes
 * GET /admin/support — page render (404 when the feature is off)
 * POST /admin/support — message delivery to the host
 *
 * Sits beside the story `@story:pages.asking-the-host-for-help`: the story
 * owns the owner's journey through the rendered page and form, so these own
 * the branch cover and the requests only a crafted POST can make — a missing
 * CSRF token, an injected submitter email the form never offered, a message
 * past the textarea's browser-enforced limit, and the 404/403 guards. The
 * delivery, nag, and failed-delivery tests stay because Cucumber runs do
 * not count towards coverage and these routes have no other direct cover.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  awaitTestRequest,
  installRecordingFetch,
  mockFormRequest,
} from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
  testCookie,
} from "#test-utils/session.ts";

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
      test("shows the Support link in the settings sub-nav", async () => {
        // The story proves the link is gone when the host is silent; this
        // owns the other side of that branch — the link when they listen.
        const response = await adminGet("/admin/settings");
        const html = await response.text();
        expect(html).toContain('href="/admin/support"');
      });

      test("renders the host's SUPPORT_PAGE_TEXT as markdown", async () => {
        // The story proves the owner reads the host's words; this owns the
        // template branch that renders them (the story's runs do not count
        // towards coverage).
        using _env = withEnv({
          SUPPORT_PAGE_TEXT: "# Help Center\\n\\nReach out anytime",
        });
        const response = await adminGet("/admin/support");
        const html = await response.text();
        expect(html).toContain("<h1>Help Center</h1>");
        expect(html).toContain("<p>Reach out anytime</p>");
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
          // The nag branch of the page: rendered only when a submission was
          // recorded inside the nag window. The words before the bold time
          // value come from the catalog key support.last_submitted.
          expect(html).toContain("You last submitted this form");
        } finally {
          mock.restore();
        }
      });

      test("rejects a message that exceeds the maximum length", async () => {
        // The browser's own maxlength rule blocks this send; only a crafted
        // POST can reach the server-side length check.
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
        // The page renders no form in this state, so no browser could send
        // this POST; only a crafted request reaches the guard.
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
    // No page exists to render a form, so no browser could send this POST.
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    const { response } = await adminFormPost("/admin/support", {
      message: "Help",
    });
    expect(response.status).toBe(404);
  });
});
