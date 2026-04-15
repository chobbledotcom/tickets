import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminSettingsPage", () => {
  const defaultState: SettingsPageState = {
    bookingFee: "0",
    businessEmail: "",
    country: "GB",
    embedHosts: "",
    headerImageUrl: "",
    paymentProvider: "",
    showPublicSite: false,
    squareSandbox: false,
    squareTokenConfigured: false,
    squareWebhookConfigured: false,
    storageEnabled: false,
    stripeKeyConfigured: false,
    stripeKeyMode: null,
    termsAndConditions: "",
    theme: "light",
    webhookUrl: "https://example.com/payment/webhook",
  };

  test("shows square webhook configured message when key is set", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState,
      paymentProvider: "square",
      squareTokenConfigured: true,
      squareWebhookConfigured: true,
    });
    expect(html).toContain("A webhook signature key is currently configured");
    expect(html).toContain("Enter a new key below to replace it");
  });

  test("shows square webhook not configured message when key is not set", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState,
      paymentProvider: "square",
      squareTokenConfigured: true,
    });
    expect(html).toContain("No webhook signature key is configured");
    expect(html).toContain("Follow the steps above to set one up");
  });

  test("shows sandbox checkbox checked when sandbox mode enabled", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState,
      paymentProvider: "square",
      squareSandbox: true,
      squareTokenConfigured: true,
    });
    expect(html).toContain("Sandbox mode");
    expect(html).toContain('name="square_sandbox"');
  });

  test("shows settings sub-navigation", () => {
    const html = adminSettingsPage(TEST_SESSION, defaultState);
    expect(html).toContain('href="/admin/settings-advanced"');
    expect(html).toContain('href="/admin/backup"');
    expect(html).toContain('href="/admin/debug"');
  });
});

describe("adminAdvancedSettingsPage", () => {
  const advancedDefaultState: AdvancedSettingsPageState = {
    adminTemplates: { html: "", subject: "", text: "" },
    appleWalletConfigured: false,
    appleWalletPassTypeId: "",
    appleWalletTeamId: "",
    attendeeColumnOrder: "",
    bunnyCdnEnabled: false,
    bunnyDnsEnabled: false,
    bunnyDnsSubdomainSuffix: "",
    bunnySubdomain: "",
    businessEmail: "",
    cdnHostname: "",
    confirmationTemplates: { html: "", subject: "", text: "" },
    customDomain: "",
    customDomainLastValidated: "",
    emailApiKeyConfigured: false,
    emailFromAddress: "",
    emailProvider: "",
    eventColumnOrder: "",
    googleWalletConfigured: false,
    googleWalletIssuerId: "",
    googleWalletServiceAccountEmail: "",
    hostAppleWalletLabel: "",
    hostEmailLabel: "",
    hostGoogleWalletLabel: "",
    showPublicApi: false,
    subdomainPreview: "",
    subdomainPreviewFullDomain: "",
    theme: "light",
  };

  test("shows email provider selection when configured", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      emailFromAddress: "from@test.com",
      emailProvider: "resend",
    });
    expect(html).toContain('value="resend"');
    expect(html).toContain("Send Test Email");
    expect(html).toContain('value="from@test.com"');
  });

  test("hides test button when no email provider configured", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, advancedDefaultState);
    expect(html).not.toContain("Send Test Email");
  });

  test("uses business email as from address placeholder", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      businessEmail: "biz@example.com",
    });
    expect(html).toContain('placeholder="biz@example.com"');
  });

  test("uses default placeholder when no business email", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, advancedDefaultState);
    expect(html).toContain('placeholder="tickets@yourdomain.com"');
  });

  test("shows host email label when hostEmailLabel is set", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      hostEmailLabel: "Host Resend (noreply@example.com)",
    });
    expect(html).toContain("Host Resend (noreply@example.com)");
  });

  test("shows None disabled when no hostEmailLabel set", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, advancedDefaultState);
    expect(html).toContain("None (disabled)");
  });

  test("shows warning about careful changes", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, advancedDefaultState);
    expect(html).toContain("Be careful changing settings on this page");
  });

  test("shows breadcrumb back to settings", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, advancedDefaultState);
    expect(html).toContain('href="/admin/settings"');
  });

  test("shows subdomain preview confirmation when subdomainPreview is set", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      bunnyDnsSubdomainSuffix: ".tickets.example.com",
      subdomainPreview: "myevent",
      subdomainPreviewFullDomain: "myevent.tickets.example.com",
    });
    expect(html).toContain("myevent.tickets.example.com");
    expect(html).toContain("is available");
    expect(html).toContain('name="save"');
    expect(html).toContain("Confirm registration");
    expect(html).toContain('value="myevent"');
  });
});
