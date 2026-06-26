import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { resetEngine } from "#shared/email-renderer.ts";
import {
  adminGet,
  assertJson,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  useSetting,
} from "#test-utils";

describeWithEnv("admin email templates", { db: true }, () => {
  useSetting({ currency: "GBP" });
  beforeEach(resetEngine);
  afterEach(resetEngine);

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

  function expectTemplatesMatch(
    type: "confirmation" | "admin",
    expected: {
      subject: string | null;
      html: string | null;
      text: string | null;
    },
  ) {
    const templates = settings.email.templateSet(type);
    expect(templates.subject).toBe(expected.subject);
    expect(templates.html).toBe(expected.html);
    expect(templates.text).toBe(expected.text);
  }

  function expectTemplatesAllNull(type: "confirmation" | "admin") {
    const templates = settings.email.templateSet(type);
    expect(templates.subject).toBe("");
    expect(templates.html).toBe("");
    expect(templates.text).toBe("");
  }

  async function postPreviewForm(fields: Record<string, string>) {
    return await postTemplateForm(
      "/admin/settings/email-templates/preview",
      fields,
    );
  }

  function assertJsonError(
    request: Promise<Response>,
    status: number,
    errorSubstring: string,
  ) {
    return assertJson(request, status, (json) => {
      expect(json.error).toContain(errorSubstring);
    });
  }

  describe("settings page", () => {
    test("shows email template sections", async () => {
      const response = await adminGet("/admin/settings-advanced");
      await expectHtmlResponse(
        response,
        200,
        "Confirmation Email Template",
        "Admin Notification Email Template",
      );
    });

    test("shows default templates as placeholders", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain("Your tickets for");
      expect(html).toContain("New registration");
    });

    test("uses 'Leave blank' placeholder for html/text bodies", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain(
        'placeholder="Leave blank to use default template"',
      );
    });

    test("shows edit default template links for html/text bodies", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain('data-fill-default="confirmation_html"');
      expect(html).toContain('data-fill-default="confirmation_text"');
      expect(html).toContain('data-fill-default="admin_html"');
      expect(html).toContain('data-fill-default="admin_text"');
      expect(html).toContain("Edit default template");
    });

    test("includes default templates as data attributes", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await response.text();
      expect(html).toContain("data-default-tpl=");
    });
  });

  describe("POST /admin/settings/email-templates/confirmation", () => {
    testRequiresAuth("/admin/settings/email-templates/confirmation", {
      body: {
        subject: "test",
      },
      method: "POST",
    });

    test("saves custom confirmation template", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        {
          html: "<b>{{ attendee.name }}</b>",
          subject: "Custom: {{ listing_names }}",
          text: "Hi {{ attendee.name }}",
        },
      );

      expect(response.status).toBe(302);
      await expectTemplatesMatch("confirmation", {
        html: "<b>{{ attendee.name }}</b>",
        subject: "Custom: {{ listing_names }}",
        text: "Hi {{ attendee.name }}",
      });
    });

    test("stores templates encrypted at rest", async () => {
      await postTemplateForm("/admin/settings/email-templates/confirmation", {
        html: "<b>{{ attendee.name }}</b>",
        subject: "Custom: {{ listing_names }}",
        text: "Hi {{ attendee.name }}",
      });
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      // Raw DB values should be encrypted, not plaintext
      const rawSubject = settings.getCachedRaw(
        CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
      );
      expect(rawSubject).not.toBeNull();
      expect(rawSubject!.startsWith("enc:1:")).toBe(true);
      expect(rawSubject).not.toContain("listing_names");

      const rawHtml = settings.getCachedRaw(
        CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML,
      );
      expect(rawHtml!.startsWith("enc:1:")).toBe(true);

      const rawText = settings.getCachedRaw(
        CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT,
      );
      expect(rawText!.startsWith("enc:1:")).toBe(true);

      // But getEmailTemplateSet should return decrypted values
      await expectTemplatesMatch("confirmation", {
        html: "<b>{{ attendee.name }}</b>",
        subject: "Custom: {{ listing_names }}",
        text: "Hi {{ attendee.name }}",
      });
    });

    test("clears template when empty values submitted", async () => {
      await settings.update.email.template(
        "confirmation",
        "subject",
        "Custom subject",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        { html: "", subject: "", text: "" },
      );

      expect(response.status).toBe(302);
      await expectTemplatesAllNull("confirmation");
    });

    test("rejects invalid Liquid syntax", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/confirmation",
        { html: "", subject: "{% for x in items %}unclosed", text: "" },
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid template syntax"),
        false,
      );
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
        { html: "x".repeat(51_201), subject: "", text: "" },
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("exceeds maximum length"),
        false,
      );
    });
  });

  describe("POST /admin/settings/email-templates/admin", () => {
    test("saves custom admin template", async () => {
      const response = await postTemplateForm(
        "/admin/settings/email-templates/admin",
        {
          html: "<p>Admin HTML</p>",
          subject: "New: {{ attendee.name }}",
          text: "Admin text",
        },
      );

      expect(response.status).toBe(302);
      const templates = settings.email.templateSet("admin");
      expect(templates.subject).toBe("New: {{ attendee.name }}");
    });
  });

  describe("POST /admin/settings/email-templates/preview", () => {
    test("renders template preview with sample data", async () => {
      await assertJson(
        postPreviewForm({
          format: "text",
          template: "Hello {{ attendee.name }}",
          type: "confirmation",
        }),
        200,
        (json) => {
          expect(json.rendered).toBe("Hello Jane Smith");
        },
      );
    });

    test("returns error for invalid template syntax", async () => {
      await assertJsonError(
        postPreviewForm({
          format: "text",
          template: "{% invalid %}",
          type: "confirmation",
        }),
        400,
        "Template syntax error",
      );
    });

    test("returns error for invalid template type", async () => {
      await assertJsonError(
        postPreviewForm({
          format: "text",
          template: "test",
          type: "invalid",
        }),
        400,
        "Invalid template type",
      );
    });

    test("defaults missing preview fields to empty and rejects invalid type", async () => {
      await assertJsonError(postPreviewForm({}), 400, "Invalid template type");
    });

    test("returns error when template render throws", async () => {
      await assertJsonError(
        postPreviewForm({
          format: "text",
          template: '{% render "nonexistent" %}',
          type: "confirmation",
        }),
        400,
        "nonexistent",
      );
    });

    test("renders currency filter in preview", async () => {
      await assertJson(
        postPreviewForm({
          format: "html",
          template:
            "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
          type: "confirmation",
        }),
        200,
        (json) => {
          expect(json.rendered).toContain("£");
        },
      );
    });
  });
});
