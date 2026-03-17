import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { resetCurrencyCode, setCurrencyCodeForTest } from "#lib/currency.ts";
import {
  CONFIG_KEYS,
  getEmailTemplateSet,
  getSetting,
  invalidateSettingsCache,
  updateEmailTemplate,
} from "#lib/db/settings.ts";
import { resetEngine } from "#lib/email-renderer.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
  testCookie,
  testCsrfToken,
} from "#test-utils";

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

  async function postTemplateForm(
    path: string,
    fields: Record<string, string>,
  ) {
    return await handleRequest(
      mockFormRequest(
        path,
        { ...fields, csrf_token: await testCsrfToken() },
        await testCookie(),
      ),
    );
  }

  async function expectTemplatesMatch(
    type: "confirmation" | "admin",
    expected: {
      subject: string | null;
      html: string | null;
      text: string | null;
    },
  ) {
    const templates = await getEmailTemplateSet(type);
    expect(templates.subject).toBe(expected.subject);
    expect(templates.html).toBe(expected.html);
    expect(templates.text).toBe(expected.text);
  }

  async function expectTemplatesAllNull(type: "confirmation" | "admin") {
    const templates = await getEmailTemplateSet(type);
    expect(templates.subject).toBeNull();
    expect(templates.html).toBeNull();
    expect(templates.text).toBeNull();
  }

  async function postPreviewForm(fields: Record<string, string>) {
    return await postTemplateForm(
      "/admin/settings/email-templates/preview",
      fields,
    );
  }

  async function expectJsonError(
    response: Response,
    status: number,
    errorSubstring: string,
  ) {
    expect(response.status).toBe(status);
    const json = await response.json();
    expect(json.error).toContain(errorSubstring);
  }

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
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        {
          subject: "Custom: {{ event_names }}",
          html: "<b>{{ attendee.name }}</b>",
          text: "Hi {{ attendee.name }}",
        },
      );

      expect(response.status).toBe(302);
      await expectTemplatesMatch("confirmation", {
        subject: "Custom: {{ event_names }}",
        html: "<b>{{ attendee.name }}</b>",
        text: "Hi {{ attendee.name }}",
      });
    });

    test("stores templates encrypted at rest", async () => {
      await postTemplateForm("/admin/settings/email-templates/confirmation", {
        subject: "Custom: {{ event_names }}",
        html: "<b>{{ attendee.name }}</b>",
        text: "Hi {{ attendee.name }}",
      });

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
      await expectTemplatesMatch("confirmation", {
        subject: "Custom: {{ event_names }}",
        html: "<b>{{ attendee.name }}</b>",
        text: "Hi {{ attendee.name }}",
      });
    });

    test("clears template when empty values submitted", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom subject");
      invalidateSettingsCache();

      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        { subject: "", html: "", text: "" },
      );

      expect(response.status).toBe(302);
      await expectTemplatesAllNull("confirmation");
    });

    test("rejects invalid Liquid syntax", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        { subject: "{% for x in items %}unclosed", html: "", text: "" },
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid template syntax");
    });

    test("defaults missing form fields to empty strings", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        {},
      );

      expect(response.status).toBe(302);
      await expectTemplatesAllNull("confirmation");
    });

    test("rejects template exceeding max length", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        { subject: "", html: "x".repeat(51_201), text: "" },
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("exceeds maximum length");
    });
  });

  describe("POST /admin/settings/email-templates/admin", () => {
    test("saves custom admin template", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/admin",
        {
          subject: "New: {{ attendee.name }}",
          html: "<p>Admin HTML</p>",
          text: "Admin text",
        },
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("admin");
      expect(templates.subject).toBe("New: {{ attendee.name }}");
    });
  });

  describe("POST /admin/settings/email-templates/preview", () => {
    test("renders template preview with sample data", async () => {
      const response = await postPreviewForm({
        type: "confirmation",
        template: "Hello {{ attendee.name }}",
        format: "text",
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toBe("Hello Jane Smith");
    });

    test("returns error for invalid template syntax", async () => {
      const response = await postPreviewForm({
        type: "confirmation",
        template: "{% invalid %}",
        format: "text",
      });

      await expectJsonError(response, 400, "Template syntax error");
    });

    test("returns error for invalid template type", async () => {
      const response = await postPreviewForm({
        type: "invalid",
        template: "test",
        format: "text",
      });

      await expectJsonError(response, 400, "Invalid template type");
    });

    test("defaults missing preview fields to empty and rejects invalid type", async () => {
      const response = await postPreviewForm({});

      await expectJsonError(response, 400, "Invalid template type");
    });

    test("returns error when template render throws", async () => {
      const response = await postPreviewForm({
        type: "confirmation",
        template: '{% render "nonexistent" %}',
        format: "text",
      });

      await expectJsonError(response, 400, "nonexistent");
    });

    test("renders currency filter in preview", async () => {
      const response = await postPreviewForm({
        type: "confirmation",
        template:
          "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
        format: "html",
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toContain("£");
    });
  });
});
