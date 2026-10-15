import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { EmailNotificationsForm } from "#templates/admin/settings/email.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

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

    says(html, "Email Provider");
    says(html, '<select name="email_provider">');
    says(html, '<option selected value="resend">Resend</option>');
    says(html, '<option value="">Host email</option>');
    says(html, '<option value="mailgun-eu">Mailgun (EU)</option>');
  });

  test("falls back to the none option when no host email exists", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    says(html, '<option selected value="">None (disabled)</option>');
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

    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password" value="${MASK_SENTINEL}">`,
    );
    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_from_address" placeholder="owner@site.example" type="email" value="tickets@site.example">`,
    );
    says(html, "API Key");
    says(html, "From Address");
  });

  test("leaves the API key blank and hints the from address fallback", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password">`,
    );
    says(
      html,
      `name="email_from_address" placeholder="tickets@yourdomain.com" type="email" value=""`,
    );
  });

  test("offers the send-test form only once a provider is chosen", () => {
    const off = String(EmailNotificationsForm(advancedDefaultState));
    assert(!off.includes('action="/admin/settings/email/test"'));

    const on = String(
      EmailNotificationsForm({
        ...advancedDefaultState,
        emailProvider: "postmark",
      }),
    );
    says(on, 'action="/admin/settings/email/test"');
    says(on, 'id="settings-email-test"');
    says(on, "Send Test Email");
  });

  test("posts to the email settings route with its save button", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    says(html, "Email Notifications");
    says(html, 'action="/admin/settings/email"');
    says(html, 'id="settings-email"');
    says(html, "Save Email Settings");
    says(html, 'href="/admin/guide#email"');
  });
});
