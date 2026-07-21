import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#shared/db/settings/mask.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { advancedDefaultState } from "./state.ts";

describe("adminAdvancedSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the SMS gateway card with current values", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayBaseUrl: "https://sms.example.com",
      smsGatewayUsername: "myuser",
    });
    expect(html).toContain("SMS Gateway");
    expect(html).toContain('name="sms_gateway_username"');
    expect(html).toContain("myuser");
    expect(html).toContain("https://sms.example.com");
    expect(html).toContain(`minlength="${SMS_PASSPHRASE_MIN_LENGTH}"`);
  });

  test("masks the SMS gateway secrets when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      smsGatewayPassphraseConfigured: true,
      smsGatewayPasswordConfigured: true,
      smsGatewayWebhookConfigured: true,
    });
    expect(html).toContain('name="sms_gateway_password"');
    expect(html).toContain('name="sms_gateway_passphrase"');
    expect(html).toContain('name="sms_gateway_webhook_secret"');
    expect(html).toContain(MASK_SENTINEL);
  });

  test("shows email provider selection when configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      emailFromAddress: "from@test.com",
      emailProvider: "resend",
    });
    expect(html).toContain('value="resend"');
    expect(html).toContain("Send Test Email");
    expect(html).toContain('value="from@test.com"');
  });

  test("hides test button when no email provider configured", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    expect(html).not.toContain("Send Test Email");
  });

  test("uses business email as from address placeholder", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      businessEmail: "biz@example.com",
    });
    expect(html).toContain('placeholder="biz@example.com"');
  });

  test("uses default placeholder when no business email", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    expect(html).toContain('placeholder="tickets@yourdomain.com"');
  });

  test("shows host email label when hostEmailLabel is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      hostEmailLabel: "Host Resend (noreply@example.com)",
    });
    expect(html).toContain("Host Resend (noreply@example.com)");
  });

  test("shows None disabled when no hostEmailLabel set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    expect(html).toContain("None (disabled)");
  });

  test("shows warning about careful changes", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    expect(html).toContain("Be careful changing settings on this page");
  });

  test("shows breadcrumb back to settings", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, advancedDefaultState);
    expect(html).toContain('href="/admin/settings"');
  });

  test("shows subdomain preview confirmation when subdomainPreview is set", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      bunnyDnsSubdomainSuffix: ".tickets.example.com",
      subdomainPreview: "mylisting",
      subdomainPreviewFullDomain: "mylisting.tickets.example.com",
    });
    expect(html).toContain("mylisting.tickets.example.com");
    expect(html).toContain("is available");
    expect(html).toContain('name="save"');
    expect(html).toContain("Confirm registration");
    expect(html).toContain('value="mylisting"');
  });

  test("custom domain form warns Square users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      paymentProvider: "square",
    });
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
  });

  test("subdomain form warns Stripe users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      paymentProvider: "stripe",
    });
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
  });

  test("does not warn about webhooks for providers without webhooks", () => {
    const html = adminAdvancedSettingsPage(OWNER_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      bunnyDnsEnabled: true,
      paymentProvider: "sumup",
    });
    expect(html).not.toContain(
      "Changing your domain changes your payment webhook",
    );
  });
});
