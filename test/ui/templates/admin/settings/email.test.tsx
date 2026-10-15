import { assert, assertStringIncludes } from "@std/assert";
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

    assertStringIncludes(html, "Email Provider");
    assertStringIncludes(html, '<select name="email_provider">');
    assertStringIncludes(
      html,
      '<option selected value="resend">Resend</option>',
    );
    assertStringIncludes(html, '<option value="">Host email</option>');
    assertStringIncludes(
      html,
      '<option value="mailgun-eu">Mailgun (EU)</option>',
    );
  });

  test("falls back to the none option when no host email exists", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    assertStringIncludes(
      html,
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

    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password" value="${MASK_SENTINEL}">`,
    );
    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_from_address" placeholder="owner@site.example" type="email" value="tickets@site.example">`,
    );
    assertStringIncludes(html, "API Key");
    assertStringIncludes(html, "From Address");
  });

  test("leaves the API key blank and hints the from address fallback", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password">`,
    );
    assertStringIncludes(
      html,
      `name="email_from_address" placeholder="tickets@yourdomain.com" type="email" value=""`,
    );
  });

  test("offers the send-test form only once a provider is chosen", () => {
    const off = String(EmailNotificationsForm(advancedDefaultState));
    assert(
      !off.includes('action="/admin/settings/email/test"'),
      "the value should not contain the searched item",
    );

    const on = String(
      EmailNotificationsForm({
        ...advancedDefaultState,
        emailProvider: "postmark",
      }),
    );
    assertStringIncludes(on, 'action="/admin/settings/email/test"');
    assertStringIncludes(on, 'id="settings-email-test"');
    assertStringIncludes(on, "Send Test Email");
  });

  test("posts to the email settings route with its save button", () => {
    const html = String(EmailNotificationsForm(advancedDefaultState));

    assertStringIncludes(html, "Email Notifications");
    assertStringIncludes(html, 'action="/admin/settings/email"');
    assertStringIncludes(html, 'id="settings-email"');
    assertStringIncludes(html, "Save Email Settings");
    assertStringIncludes(html, 'href="/admin/guide#email"');
  });
});
