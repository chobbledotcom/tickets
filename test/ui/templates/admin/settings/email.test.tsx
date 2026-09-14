import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { EmailNotificationsForm } from "#templates/admin/settings/email.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("EmailNotificationsForm", () => {
  beforeAll(setupAdminPageTest);

  test("renders provider choices with the host label as the none option", () => {
    const html = String(
      EmailNotificationsForm({
        ...advancedDefaultState,
        emailProvider: "resend",
        hostEmailLabel: "Host email",
      }),
    );

    expect(html).toContain("Email Provider");
    expect(html).toContain('<select name="email_provider">');
    expect(html).toContain('<option selected value="resend">Resend</option>');
    expect(html).toContain('<option value="">Host email</option>');
    expect(html).toContain('<option value="mailgun-eu">Mailgun (EU)</option>');
  });

  test("falls back to the none option when no host email exists", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    expect(html).toContain(
      '<option selected value="">None (disabled)</option>',
    );
  });

  test("masks a stored API key and shows the saved from address", () => {
    const html = String(
      EmailNotificationsForm({
        ...advancedDefaultState,
        businessEmail: "owner@site.example",
        emailApiKeyConfigured: true,
        emailFromAddress: "tickets@site.example",
      }),
    );

    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password" value="${MASK_SENTINEL}">`,
    );
    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_from_address" placeholder="owner@site.example" type="email" value="tickets@site.example">`,
    );
    expect(html).toContain("API Key");
    expect(html).toContain("From Address");
  });

  test("leaves the API key blank and hints the from address fallback", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password">`,
    );
    expect(html).toContain(
      `name="email_from_address" placeholder="tickets@yourdomain.com" type="email" value=""`,
    );
  });

  test("offers the send-test form only once a provider is chosen", () => {
    const off = String(EmailNotificationsForm(advancedDefaultState));
    expect(off).not.toContain('action="/admin/settings/email/test"');

    const on = String(
      EmailNotificationsForm({
        ...advancedDefaultState,
        emailProvider: "postmark",
      }),
    );
    expect(on).toContain('action="/admin/settings/email/test"');
    expect(on).toContain('id="settings-email-test"');
    expect(on).toContain("Send Test Email");
  });

  test("posts to the email settings route with its save button", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    expect(html).toContain("Email Notifications");
    expect(html).toContain('action="/admin/settings/email"');
    expect(html).toContain('id="settings-email"');
    expect(html).toContain("Save Email Settings");
    expect(html).toContain('href="/admin/guide#email"');
  });
});
