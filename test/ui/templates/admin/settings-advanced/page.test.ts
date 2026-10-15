import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";
import { advancedDefaultState } from "./state.ts";

describe("adminAdvancedSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the SMS gateway card with current values", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayBaseUrl: "https://sms.example.com",
      smsGatewayUsername: "myuser",
    });
    says(html, "SMS Gateway");
    says(html, 'name="sms_gateway_username"');
    says(html, "myuser");
    says(html, "https://sms.example.com");
    says(html, `minlength="${SMS_PASSPHRASE_MIN_LENGTH}"`);
  });

  test("masks the SMS gateway secrets when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayPassphraseConfigured: true,
      smsGatewayPasswordConfigured: true,
      smsGatewayWebhookConfigured: true,
    });
    says(html, 'name="sms_gateway_password"');
    says(html, 'name="sms_gateway_passphrase"');
    says(html, 'name="sms_gateway_webhook_secret"');
    says(html, MASK_SENTINEL);
  });

  test("shows email provider selection when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      emailFromAddress: "from@test.com",
      emailProvider: "resend",
    });
    says(html, 'value="resend"');
    says(html, "Send Test Email");
    says(html, 'value="from@test.com"');
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
    says(html, 'placeholder="biz@example.com"');
  });

  test("uses default placeholder when no business email", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    says(html, 'placeholder="tickets@yourdomain.com"');
  });

  test("shows host email label when hostEmailLabel is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      hostEmailLabel: "Host Resend (noreply@example.com)",
    });
    says(html, "Host Resend (noreply@example.com)");
  });

  test("shows None disabled when no hostEmailLabel set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    says(html, "None (disabled)");
  });

  test("shows warning about careful changes", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    says(html, "Be careful changing settings on this page");
  });

  test("shows breadcrumb back to settings", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    says(html, 'href="/admin/settings"');
  });

  test("shows subdomain preview confirmation when subdomainPreview is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      bunnyDnsSubdomainSuffix: ".tickets.example.com",
      subdomainPreview: "mylisting",
      subdomainPreviewFullDomain: "mylisting.tickets.example.com",
    });
    says(html, "mylisting.tickets.example.com");
    says(html, "is free.");
    says(html, 'name="save"');
    says(html, "Register this subdomain");
    says(html, 'value="mylisting"');
  });

  test("custom domain form warns Square users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      existingPaymentProvider: "square",
    });
    says(html, "Changing your domain changes your payment webhook");
    says(html, 'href="/admin/settings#settings-square-webhook"');
  });

  test("subdomain form warns Stripe users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      existingPaymentProvider: "stripe",
    });
    says(html, "Changing your domain changes your payment webhook");
    says(html, 'href="/admin/settings#settings-stripe"');
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
});
