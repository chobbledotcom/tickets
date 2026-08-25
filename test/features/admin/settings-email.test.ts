// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end

/** Where each form's redirect lands: the advanced page, anchored to the form. */
const SETTINGS_FORM_URL =
  "/admin/settings-advanced?form=settings-email#settings-email";
const TEST_FORM_URL =
  "/admin/settings-advanced?form=settings-email-test#settings-email-test";

describeWithEnv("server (admin settings: email)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  /** Configure the email provider + business email so the routes have stored
   *  values to change or send with. Shared by both describes. */
  const configureEmailForTest = async (): Promise<void> => {
    const { settings } = await import("#db/settings.ts");
    const { updateBusinessEmail: setBizEmail } = await import(
      "#shared/validation/email.ts"
    );

    await settings.update.email.provider("resend");
    await settings.update.email.apiKey("re_test_key");
    await settings.update.email.fromAddress("from@test.com");
    await setBizEmail("admin@test.com");
    settings.invalidateCache();
  };

  /** Reload settings from the database and return the stored email trio. */
  const storedEmailSettings = async (): Promise<{
    apiKey: string;
    fromAddress: string;
    provider: string;
  }> => {
    const { ALL_SETTINGS_KEYS, settings } = await import("#db/settings.ts");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    return {
      apiKey: settings.email.apiKey,
      fromAddress: settings.email.fromAddress,
      provider: settings.email.provider,
    };
  };

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

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email settings updated"),
      )(response);
      expect(await storedEmailSettings()).toEqual({
        apiKey: "re_test_123",
        fromAddress: "tickets@example.com",
        provider: "resend",
      });
    });

    test("disables email when provider is empty", async () => {
      await configureEmailForTest();

      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "",
      });

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email provider disabled"),
      )(response);
      expect(await storedEmailSettings()).toEqual({
        apiKey: "",
        fromAddress: "",
        provider: "",
      });
    });

    test("rejects invalid email provider", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "invalid-provider",
      });

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Invalid email provider"),
        false,
      )(response);
    });

    test("rejects invalid from-address format", async () => {
      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "re_test_123",
        email_from_address: "not-an-email",
        email_provider: "resend",
      });

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Invalid from-address format"),
        false,
      )(response);
    });

    test("disables email when provider field is missing", async () => {
      const { response } = await adminFormPost("/admin/settings/email");

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email provider disabled"),
      )(response);
    });

    test("saves provider without updating key when key is empty", async () => {
      await configureEmailForTest();

      const { response } = await adminFormPost("/admin/settings/email", {
        email_api_key: "",
        email_from_address: "",
        email_provider: "postmark",
      });

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email settings updated"),
      )(response);
      expect(await storedEmailSettings()).toEqual({
        apiKey: "re_test_key",
        fromAddress: "from@test.com",
        provider: "postmark",
      });
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
    test("shows error when email not configured", async () => {
      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email not configured"),
        false,
      )(response);
    });

    test("shows error when no business email set", async () => {
      const { settings } = await import("#db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("No business email set"),
        false,
      )(response);
    });

    test("sends test email and redirects with success including status code", async () => {
      await configureEmailForTest();
      using _fetch = stubFetch(new Response());

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("Test email sent (status 200)"),
      )(response);
    });

    test("shows error when email API returns non-2xx status", async () => {
      await configureEmailForTest();
      using _fetch = stubFetch(new Response("Forbidden", { status: 403 }));

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        "Test email failed (status 403). Your email provider said: Forbidden",
        false,
      )(response);
    });

    test("shows SendGrid's own message when the reply carries one", async () => {
      await configureEmailForTest();
      const { settings } = await import("#db/settings.ts");
      await settings.update.email.provider("sendgrid");
      settings.invalidateCache();
      using _fetch = stubFetch(
        new Response(
          '{"errors":[{"message":"The from address does not match a verified Sender Identity","field":"from","help":null}]}',
          { status: 403 },
        ),
      );

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        "Test email failed (status 403). Your email provider said: The from address does not match a verified Sender Identity",
        false,
      )(response);
    });

    test("shows just the status when the reply body is empty", async () => {
      await configureEmailForTest();
      using _fetch = stubFetch(new Response(null, { status: 403 }));

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        "Test email failed (status 403)",
        false,
      )(response);
    });

    test("shows error when email send encounters network error", async () => {
      await configureEmailForTest();
      using _fetch = stubFetch(new Error("Network error"));

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("Test email failed (no response)"),
        false,
      )(response);
    });
  });

  describe("settings-advanced page email provider display", () => {
    test("shows email provider when configured", async () => {
      const { settings } = await import("#db/settings.ts");

      await settings.update.email.provider("resend");
      await settings.update.email.fromAddress("from@test.com");

      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('value="resend"');
      expect(html).toContain("Send Test Email");
    });
  });
});
