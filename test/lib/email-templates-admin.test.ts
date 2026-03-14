import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getSetting,
  getEmailTemplateSet,
  invalidateSettingsCache,
  updateEmailTemplate,
  CONFIG_KEYS,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  testCookie,
  testCsrfToken,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";
import { resetEngine } from "#lib/email-renderer.ts";
import { resetCurrencyCode, setCurrencyCodeForTest } from "#lib/currency.ts";

describe("admin email templates", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    setCurrencyCodeForTest("GBP");
    resetEngine();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetCurrencyCode();
    resetEngine();
    resetDb();
  });

  describe("settings page", () => {
    test("shows email template sections", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Confirmation Email Template",
        "Admin Notification Email Template",
      );
    });

    test("shows default templates as placeholders", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Your tickets for");
      expect(html).toContain("New registration");
    });

    test("uses 'Leave blank' placeholder for html/text bodies", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain(
        'placeholder="Leave blank to use default template"',
      );
    });

    test("shows edit default template links for html/text bodies", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('data-fill-default="confirmation_html"');
      expect(html).toContain('data-fill-default="confirmation_text"');
      expect(html).toContain('data-fill-default="admin_html"');
      expect(html).toContain('data-fill-default="admin_text"');
      expect(html).toContain("Edit default template");
    });

    test("includes default templates as data attributes", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("data-default-tpl=");
    });
  });

  describe("POST /admin/settings/email-templates/confirmation", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", {
          subject: "test",
        }),
      );
      expectAdminRedirect(response);
    });

    test("saves custom confirmation template", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            subject: "Custom: {{ event_names }}",
            html: "<b>{{ attendee.name }}</b>",
            text: "Hi {{ attendee.name }}",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBe("Custom: {{ event_names }}");
      expect(templates.html).toBe("<b>{{ attendee.name }}</b>");
      expect(templates.text).toBe("Hi {{ attendee.name }}");
    });

    test("stores templates encrypted at rest", async () => {
      await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            subject: "Custom: {{ event_names }}",
            html: "<b>{{ attendee.name }}</b>",
            text: "Hi {{ attendee.name }}",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      // Raw DB values should be encrypted, not plaintext
      const rawSubject = await getSetting(
        CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
      );
      expect(rawSubject).not.toBeNull();
      expect(rawSubject!.startsWith("enc:1:")).toBe(true);
      expect(rawSubject).not.toContain("event_names");

      const rawHtml = await getSetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML);
      expect(rawHtml!.startsWith("enc:1:")).toBe(true);

      const rawText = await getSetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT);
      expect(rawText!.startsWith("enc:1:")).toBe(true);

      // But getEmailTemplateSet should return decrypted values
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBe("Custom: {{ event_names }}");
      expect(templates.html).toBe("<b>{{ attendee.name }}</b>");
      expect(templates.text).toBe("Hi {{ attendee.name }}");
    });

    test("clears template when empty values submitted", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom subject");
      invalidateSettingsCache();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            subject: "",
            html: "",
            text: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBeNull();
      expect(templates.html).toBeNull();
      expect(templates.text).toBeNull();
    });

    test("rejects invalid Liquid syntax", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            subject: "{% for x in items %}unclosed",
            html: "",
            text: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid template syntax");
    });

    test("defaults missing form fields to empty strings", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBeNull();
      expect(templates.html).toBeNull();
      expect(templates.text).toBeNull();
    });

    test("rejects template exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/confirmation",
          {
            subject: "",
            html: "x".repeat(51_201),
            text: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("exceeds maximum length");
    });
  });

  describe("POST /admin/settings/email-templates/admin", () => {
    test("saves custom admin template", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/admin",
          {
            subject: "New: {{ attendee.name }}",
            html: "<p>Admin HTML</p>",
            text: "Admin text",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("admin");
      expect(templates.subject).toBe("New: {{ attendee.name }}");
    });
  });

  describe("POST /admin/settings/email-templates/preview", () => {
    test("renders template preview with sample data", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            type: "confirmation",
            template: "Hello {{ attendee.name }}",
            format: "text",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toBe("Hello Jane Smith");
    });

    test("returns error for invalid template syntax", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            type: "confirmation",
            template: "{% invalid %}",
            format: "text",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Template syntax error");
    });

    test("returns error for invalid template type", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            type: "invalid",
            template: "test",
            format: "text",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid template type");
    });

    test("defaults missing preview fields to empty and rejects invalid type", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid template type");
    });

    test("returns error when template render throws", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            type: "confirmation",
            template: '{% render "nonexistent" %}',
            format: "text",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("nonexistent");
    });

    test("renders currency filter in preview", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email-templates/preview",
          {
            type: "confirmation",
            template:
              "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
            format: "html",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toContain("£");
    });
  });
});
