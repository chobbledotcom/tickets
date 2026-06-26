import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectFlash,
  getAllActivityLog,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings: email)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/email", () => {
    testRequiresAuth("/admin/settings/email", {
      body: {
        email_provider: "resend",
      },
      method: "POST",
    });

    test("saves email provider settings", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "re_test_123",
        email_from_address: "tickets@example.com",
        email_provider: "resend",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email settings updated"));
    });

    test("disables email when provider is empty", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email provider disabled"));
    });

    test("rejects invalid email provider", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "invalid-provider",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid email provider"),
        false,
      );
    });

    test("rejects invalid from-address format", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "re_test_123",
        email_from_address: "not-an-email",
        email_provider: "resend",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid from-address format"),
        false,
      );
    });

    test("disables email when provider field is missing", async () => {
      const { response } = await adminFormPost("/admin/settings/email");

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email provider disabled"));
    });

    test("saves provider without updating key when key is empty", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "",
        email_from_address: "",
        email_provider: "postmark",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Email settings updated"));
    });

    test("logs activity when email provider is set", async () => {
      await adminFormPost("/admin/settings/email", {
        email_api_key: "sg_key",
        email_from_address: "from@test.com",
        email_provider: "sendgrid",
      });

      const logs = await getAllActivityLog();
      expect(logs.some((l) => l.message === "Email settings updated")).toBe(
        true,
      );
    });

    test("advanced settings page displays email configuration section", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('id="settings-email"');
      expect(html).toContain("email_provider");
      expect(html).toContain("Email Notifications");
    });
  });

  describe("POST /admin/settings/email/test", () => {
    /** Configure the email provider + business email so the test endpoint
     *  actually sends. Shared by every test in this describe — only the
     *  `withMocks` stub (and the expected flash) varies. */
    const configureEmailForTest = async (): Promise<void> => {
      const { settings } = await import("#shared/db/settings.ts");
      const { updateBusinessEmail: setBizEmail } = await import(
        "#shared/validation/email.ts"
      );

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");
      await setBizEmail("admin@test.com");
      settings.invalidateCache();
    };

    test("shows error when email not configured", async () => {
      const { response } = await adminFormPost("/admin/settings/email/test");

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Email not configured"),
        false,
      );
    });

    test("shows error when no business email set", async () => {
      const { settings } = await import("#shared/db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");

      const { response } = await adminFormPost("/admin/settings/email/test");

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("No business email set"),
        false,
      );
    });

    test("sends test email and redirects with success including status code", async () => {
      await configureEmailForTest();

      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.resolve(new Response())),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email sent (status 200)"),
          );
        },
      );
    });

    test("shows error when email API returns non-2xx status", async () => {
      await configureEmailForTest();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Forbidden", { status: 403 })),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email failed (status 403)"),
            false,
          );
        },
      );
    });

    test("shows error when email send encounters network error", async () => {
      await configureEmailForTest();

      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.reject(new Error("Network error")),
          ),
        async () => {
          const { response } = await adminFormPost(
            "/admin/settings/email/test",
          );

          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Test email failed (no response)"),
            false,
          );
        },
      );
    });
  });

  describe("settings-advanced page email provider display", () => {
    test("shows email provider when configured", async () => {
      const { settings } = await import("#shared/db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.fromAddress("from@test.com");

      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('value="resend"');
      expect(html).toContain("Send Test Email");
    });
  });
});
