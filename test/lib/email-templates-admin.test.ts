import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getEmailTemplateSet,
  invalidateSettingsCache,
  updateEmailTemplate,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";
import { resetEngine } from "#lib/email-renderer.ts";
import { resetCurrencyCode, setCurrencyCodeForTest } from "#lib/currency.ts";

describe("admin email templates", () => {
  let cookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    resetTestSlugCounter();
    setCurrencyCodeForTest("GBP");
    resetEngine();
    await createTestDbWithSetup();
    const session = await loginAsAdmin();
    cookie = session.cookie;
    csrfToken = session.csrfToken;
  });

  afterEach(() => {
    resetCurrencyCode();
    resetEngine();
    resetDb();
  });

  describe("settings page", () => {
    test("shows email template sections", async () => {
      const response = await awaitTestRequest("/admin/settings", { cookie });
      await expectHtmlResponse(response, 200, "Confirmation Email Template", "Admin Notification Email Template");
    });

    test("shows reset button when custom template is set", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom subject");
      invalidateSettingsCache();

      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).toContain("Reset Confirmation Template to Default");
    });

    test("hides reset button when no custom template is set", async () => {
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Reset Confirmation Template to Default");
    });
  });

  describe("POST /admin/settings/email-templates/confirmation", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", { subject: "test" }),
      );
      expectAdminRedirect(response);
    });

    test("saves custom confirmation template", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", {
          subject: "Custom: {{ event_names }}",
          html: "<b>{{ attendee.name }}</b>",
          text: "Hi {{ attendee.name }}",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBe("Custom: {{ event_names }}");
      expect(templates.html).toBe("<b>{{ attendee.name }}</b>");
      expect(templates.text).toBe("Hi {{ attendee.name }}");
    });

    test("clears template when empty values submitted", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom subject");
      invalidateSettingsCache();

      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", {
          subject: "",
          html: "",
          text: "",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBeNull();
      expect(templates.html).toBeNull();
      expect(templates.text).toBeNull();
    });

    test("rejects invalid Liquid syntax", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", {
          subject: "{% for x in items %}unclosed",
          html: "",
          text: "",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid template syntax");
    });

    test("rejects template exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation", {
          subject: "",
          html: "x".repeat(51_201),
          text: "",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("exceeds maximum length");
    });
  });

  describe("POST /admin/settings/email-templates/admin", () => {
    test("saves custom admin template", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/admin", {
          subject: "New: {{ attendee.name }}",
          html: "<p>Admin HTML</p>",
          text: "Admin text",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("admin");
      expect(templates.subject).toBe("New: {{ attendee.name }}");
    });
  });

  describe("POST /admin/settings/email-templates/confirmation/reset", () => {
    test("resets confirmation template to defaults", async () => {
      await updateEmailTemplate("confirmation", "subject", "Custom");
      await updateEmailTemplate("confirmation", "html", "<b>Custom</b>");
      await updateEmailTemplate("confirmation", "text", "Custom text");
      invalidateSettingsCache();

      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/confirmation/reset", {
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("confirmation");
      expect(templates.subject).toBeNull();
      expect(templates.html).toBeNull();
      expect(templates.text).toBeNull();
    });
  });

  describe("POST /admin/settings/email-templates/admin/reset", () => {
    test("resets admin template to defaults", async () => {
      await updateEmailTemplate("admin", "subject", "Custom");
      invalidateSettingsCache();

      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/admin/reset", {
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(302);
      const templates = await getEmailTemplateSet("admin");
      expect(templates.subject).toBeNull();
    });
  });

  describe("POST /admin/settings/email-templates/preview", () => {
    test("renders template preview with sample data", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/preview", {
          type: "confirmation",
          template: "Hello {{ attendee.name }}",
          format: "text",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toBe("Hello Jane Smith");
    });

    test("returns error for invalid template syntax", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/preview", {
          type: "confirmation",
          template: "{% invalid %}",
          format: "text",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Template syntax error");
    });

    test("returns error for invalid template type", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/preview", {
          type: "invalid",
          template: "test",
          format: "text",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid template type");
    });

    test("renders currency filter in preview", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/email-templates/preview", {
          type: "confirmation",
          template: "{% for entry in entries %}{{ entry.attendee.price_paid | currency }}{% endfor %}",
          format: "html",
          csrf_token: csrfToken,
        }, cookie),
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.rendered).toContain("£");
    });
  });
});
