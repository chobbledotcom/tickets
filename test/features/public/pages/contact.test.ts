import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handlePublicContactSubmit } from "#routes/public/pages.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import {
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  awaitTestRequest,
  installRecordingFetch,
  mockFormRequest,
  withMocks,
} from "#test-utils/mocks.ts";
import { activateContactForm, enablePublicSite } from "#test-utils/settings.ts";

const BOTPOISON_ENV = {
  BOTPOISON_PUBLIC_KEY: "pk_test_public",
  BOTPOISON_SECRET_KEY: "sk_test_secret",
};

const submitContact = async (
  fields: Record<string, string>,
  csrfToken?: string,
): Promise<Response> =>
  handlePublicContactSubmit(
    mockFormRequest("/contact", {
      ...fields,
      csrf_token: csrfToken ?? (await signCsrfToken()),
    }),
  );

const withContactProvider = (
  verify: boolean,
  emailStatus: number,
  body: () => Promise<void>,
): Promise<void> =>
  withMocks(
    () =>
      installRecordingFetch((url) => {
        if (url.includes("api.botpoison.com")) {
          return new Response(JSON.stringify({ ok: verify }));
        }
        if (url.includes("api.resend.com")) {
          return new Response(null, { status: emailStatus });
        }
        return null;
      }),
    body,
  );

describeWithEnv(
  "public contact submission",
  { db: true, env: BOTPOISON_ENV },
  () => {
    test("rejects an invalid email at the contact page", async () => {
      await activateContactForm();
      const response = await submitContact({
        email: "invalid",
        message: "Hello!",
      });

      expectRedirectWithFlash(
        "/contact",
        "Please enter a valid email address.",
        false,
      )(response);
    });

    test("rejects an empty message at the contact page", async () => {
      await activateContactForm();
      const response = await submitContact({
        email: "visitor@example.com",
        message: "",
      });

      expectRedirectWithFlash(
        "/contact",
        "Please enter a message.",
        false,
      )(response);
    });

    test("returns a failed puzzle to the contact page", async () => {
      await activateContactForm();
      await withContactProvider(false, 200, async () => {
        const response = await submitContact({
          _botpoison: "bad",
          email: "visitor@example.com",
          message: "Hello!",
        });

        expectRedirectWithFlash(
          "/contact",
          "Could not verify your submission. Please try again.",
          false,
        )(response);
      });
    });

    test("returns a delivery failure to the contact page", async () => {
      await activateContactForm();
      await withContactProvider(true, 500, async () => {
        const response = await submitContact({
          _botpoison: "solved",
          email: "visitor@example.com",
          message: "Hello!",
        });

        expectRedirectWithFlash(
          "/contact",
          MESSAGE_SEND_FAILED,
          false,
        )(response);
      });
    });

    test("returns a successful submission to the contact page", async () => {
      await activateContactForm();
      await withContactProvider(true, 200, async () => {
        const response = await submitContact({
          _botpoison: "solved",
          email: "visitor@example.com",
          message: "Hello!",
        });

        expectRedirectWithFlash("/contact", "Message sent", true)(response);
      });
    });

    test("returns an invalid token to the contact page", async () => {
      await activateContactForm();
      const response = await submitContact(
        { email: "visitor@example.com", message: "Hello!" },
        "invalid",
      );

      expectRedirectWithFlash(
        "/contact",
        expect.stringContaining("Invalid"),
        false,
      )(response);
    });

    test("returns not found when the contact page is empty", async () => {
      await enablePublicSite();
      const response = await awaitTestRequest("/contact");
      expect(response.status).toBe(404);
    });

    test("shows contact text without the form", async () => {
      const { settings } = await import("#db/settings.ts");
      await enablePublicSite();
      await settings.update.contactPageText("Write to the team.");
      const response = await awaitTestRequest("/contact");
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Write to the team.");
      expect(html).not.toContain('action="/contact"');
    });

    test("shows the active form without contact text", async () => {
      await activateContactForm();
      const response = await awaitTestRequest("/contact");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('action="/contact"');
    });

    test("shows success and error messages after redirects", async () => {
      await activateContactForm();
      const success = await awaitTestRequest(
        `/contact?flash=${FLASH_TEST_ID}`,
        { cookie: flashCookieHeader("Sent") },
      );
      expect(await success.text()).toContain("Sent");

      const error = await awaitTestRequest(`/contact?flash=${FLASH_TEST_ID}`, {
        cookie: flashCookieHeader("Try again", false),
      });
      expect(await error.text()).toContain("Try again");
    });
  },
);
