import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { advancedDefaultState } from "./state.ts";

describe("adminAdvancedSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the SMS gateway card with current values", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayBaseUrl: "https://sms.example.com",
      smsGatewayUsername: "myuser",
    });
    expectIncludesAll(html, [
      "SMS Gateway",
      'name="sms_gateway_username"',
      "myuser",
      "https://sms.example.com",
      `minlength="${SMS_PASSPHRASE_MIN_LENGTH}"`,
    ]);
  });

  test("masks the SMS gateway secrets when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayPassphraseConfigured: true,
      smsGatewayPasswordConfigured: true,
      smsGatewayWebhookConfigured: true,
    });
    expectIncludesAll(html, [
      'name="sms_gateway_password"',
      'name="sms_gateway_passphrase"',
      'name="sms_gateway_webhook_secret"',
      MASK_SENTINEL,
    ]);
  });

  test("shows email provider selection when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      emailFromAddress: "from@test.com",
      emailProvider: "resend",
    });
    expectIncludesAll(html, [
      'value="resend"',
      "Send Test Email",
      'value="from@test.com"',
    ]);
  });

  test("hides test button when no email provider configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    assert(!html.includes("Send Test Email"));
  });

  test("uses business email as from address placeholder", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      businessEmail: "biz@example.com",
    });
    assertStringIncludes(html, 'placeholder="biz@example.com"');
  });

  test("uses default placeholder when no business email", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    assertStringIncludes(html, 'placeholder="tickets@yourdomain.com"');
  });

  test("shows host email label when hostEmailLabel is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      hostEmailLabel: "Host Resend (noreply@example.com)",
    });
    assertStringIncludes(html, "Host Resend (noreply@example.com)");
  });

  test("shows None disabled when no hostEmailLabel set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    assertStringIncludes(html, "None (disabled)");
  });

  test("shows warning about careful changes", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    assertStringIncludes(html, "Be careful changing settings on this page");
  });

  test("shows breadcrumb back to settings", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    assertStringIncludes(html, 'href="/admin/settings"');
  });

  test("shows subdomain preview confirmation when subdomainPreview is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      bunnyDnsSubdomainSuffix: ".tickets.example.com",
      subdomainPreview: "mylisting",
      subdomainPreviewFullDomain: "mylisting.tickets.example.com",
    });
    expectIncludesAll(html, [
      "mylisting.tickets.example.com",
      "is free.",
      'name="save"',
      "Register this subdomain",
      'value="mylisting"',
    ]);
  });

  test("custom domain form warns Square users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      existingPaymentProvider: "square",
    });
    expectIncludesAll(html, [
      "Changing your domain changes your payment webhook",
      'href="/admin/settings#settings-square-webhook"',
    ]);
  });

  test("subdomain form warns Stripe users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      existingPaymentProvider: "stripe",
    });
    expectIncludesAll(html, [
      "Changing your domain changes your payment webhook",
      'href="/admin/settings#settings-stripe"',
    ]);
  });

  test("does not warn about webhooks for providers without webhooks", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      bunnyDnsEnabled: true,
      existingPaymentProvider: "sumup",
    });
    assert(!html.includes("Changing your domain changes your payment webhook"));
  });

  test("shows the run sheet template boxes only while logistics is on", () => {
    const shown = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      logisticsEnabled: true,
    });
    expectIncludesAll(shown, [
      'id="settings-logistics-run-sheet"',
      "Logistics run sheet template",
      'name="heading"',
      'name="body"',
      // The built-in template sits behind each box, ready to fill in.
      "Edit default template",
      'action="/admin/settings/logistics-run-sheet"',
    ]);

    const hidden = adminAdvancedSettingsPage(
      OWNER_SESSION,
      advancedDefaultState,
    );
    assert(!hidden.includes("settings-logistics-run-sheet"));
    assert(!hidden.includes("Logistics run sheet template"));
  });

  test("shows the saved run sheet templates in the boxes", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      logisticsEnabled: true,
      logisticsRunSheetBody:
        "{% for booking in day.bookings %}{{ booking.name }}{% endfor %}",
      logisticsRunSheetHeading: "{{ relative }}",
    });

    expectIncludesAll(html, [
      "{% for booking in day.bookings %}",
      "{{ relative }}",
    ]);
  });
});
