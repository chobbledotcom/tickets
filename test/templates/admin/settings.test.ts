import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  hasCheckedInput,
  setupTestEncryptionKey,
  validEmail,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const defaultState = (): SettingsPageState => ({
  bookingFee: "0",
  businessEmail: "",
  calendarFeedsEnabled: false,
  calendarFeedsGroupBy: "attendees",
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
  sumupKeyConfigured: false,
  sumupKeyMode: null,
  superuser: { available: false, reason: "missing-env" },
  termsAndConditions: "",
  theme: "light",
  webhookUrl: "https://example.com/payment/webhook",
});

describe("adminSettingsPage", () => {
  test("omits the key-mode notice for a configured key with an unknown mode", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      paymentProvider: "sumup",
      sumupKeyConfigured: true,
      sumupKeyMode: null,
    });
    expect(html).toContain("A SumUp API key is currently configured");
    expect(html).not.toContain("Test mode");
    expect(html).not.toContain("Live mode");
  });

  test("shows square webhook configured message when key is set", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      paymentProvider: "square",
      squareTokenConfigured: true,
      squareWebhookConfigured: true,
    });
    expect(html).toContain("A webhook signature key is currently configured");
    expect(html).toContain("Enter a new key below to replace it");
  });

  test("shows square webhook not configured message when key is not set", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      paymentProvider: "square",
      squareTokenConfigured: true,
    });
    expect(html).toContain("No webhook signature key is configured");
    expect(html).toContain("Follow the steps above to set one up");
  });

  test("shows sandbox checkbox checked when sandbox mode enabled", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      paymentProvider: "square",
      squareSandbox: true,
      squareTokenConfigured: true,
    });
    expect(html).toContain("Sandbox mode");
    expect(html).toContain('name="square_sandbox"');
  });

  test("shows settings sub-navigation", () => {
    const html = adminSettingsPage(TEST_SESSION, defaultState());
    expect(html).toContain('href="/admin/settings-advanced"');
    expect(html).toContain('href="/admin/backup"');
    expect(html).toContain('href="/admin/debug"');
  });

  test("renders the calendar feeds form as markup, not escaped HTML", () => {
    const html = adminSettingsPage(TEST_SESSION, defaultState());
    expect(html).toContain('action="/admin/settings/calendar-feeds"');
    expect(html).toContain('name="calendar_feeds_enabled"');
    expect(html).toContain('name="calendar_feeds_group_by"');
    // The form is real markup, not an escaped string rendered as text.
    expect(html).not.toContain("&lt;form");
  });

  test("checks the calendar feeds toggle when enabled", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      calendarFeedsEnabled: true,
    });
    expect(hasCheckedInput(html, "calendar_feeds_enabled", "true")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SuperuserForm availability
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm", () => {
  test("renders 'Superuser Recovery' heading when superuser.available is true", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    expect(html).toContain("Superuser Recovery");
  });

  test("does not render form section when superuser.available is false", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: { available: false, reason: "missing-env" },
    });
    expect(html).not.toContain("Superuser Recovery");
    expect(html).not.toContain("superuser_choice");
  });

  test("does not render form section when available is false with reason 'invalid-env'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: { available: false, reason: "invalid-env" },
    });
    expect(html).not.toContain("Superuser Recovery");
    expect(html).not.toContain("superuser_choice");
  });

  test("does not render form section when available is false with reason 'invalid-username'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: { available: false, reason: "invalid-username" },
    });
    expect(html).not.toContain("Superuser Recovery");
    expect(html).not.toContain("superuser_choice");
  });
});

// ---------------------------------------------------------------------------
// Radio labels — correctness
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm radio labels", () => {
  test("renders self-managed radio label with exact grammatically-correct text", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    expect(html).toContain(
      "I understand that my attendee information cannot be decrypted without my password, and that I am responsible for storing my password securely. If I forget it, I will be locked out of my attendee records.",
    );
    expect(html).toContain("responsible");
    expect(html).not.toContain("responsiblity");
  });

  test("renders enable-superuser radio label with the admin email address interpolated", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "",
        email: validEmail("myadmin@example.com"),
        userExists: false,
        username: "myadmin",
      },
    });
    expect(html).toContain(
      "I wish to enable a &quot;super user&quot; account on this platform for my admin, myadmin@example.com.",
    );
    expect(html).toContain(
      "This user will be able to log in, decrypt attendee data, and invite a replacement owner account if I lose access.",
    );
  });
});

// ---------------------------------------------------------------------------
// Radio input values and form structure
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm form structure", () => {
  const baseSuperuser = {
    activated: false,
    available: true,
    choice: "",
    email: validEmail("admin@example.com"),
    userExists: false,
    username: "admin",
  } as const;

  test("radio inputs have correct name='superuser_choice'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    const matches = html.match(/name="superuser_choice"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });

  test("first radio has value='self-managed'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    expect(html).toContain('value="self-managed"');
  });

  test("second radio has value='enable-superuser'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    expect(html).toContain('value="enable-superuser"');
  });

  test("form action is '/admin/settings/superuser'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    expect(html).toContain('action="/admin/settings/superuser"');
  });

  test("form has id='settings-superuser' for anchor linking", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    expect(html).toContain('id="settings-superuser"');
  });

  test("form includes a CSRF token field", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: baseSuperuser,
    });
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="csrf_token"');
  });
});

// ---------------------------------------------------------------------------
// Radio pre-selection (checked state reflects persisted choice)
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm radio checked state", () => {
  test("self-managed radio is checked when choice is 'self-managed'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "self-managed",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    expect(hasCheckedInput(html, "superuser_choice", "self-managed")).toBe(
      true,
    );
    expect(hasCheckedInput(html, "superuser_choice", "enable-superuser")).toBe(
      false,
    );
  });

  test("enable-superuser radio is checked when choice is 'enabled'", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "enabled",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    expect(hasCheckedInput(html, "superuser_choice", "self-managed")).toBe(
      false,
    );
    expect(hasCheckedInput(html, "superuser_choice", "enable-superuser")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Existing-superuser state
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm existing-superuser state", () => {
  test("shows already-exists message with interpolated username", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: true,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: true,
        username: "myadmin",
      },
    });
    expect(html).toContain("Superuser myadmin is already activated.");
  });

  test("already-exists message links 'users page' to /admin/users", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: true,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: true,
        username: "myadmin",
      },
    });
    expect(html).toContain('<a href="/admin/users">users page</a>');
  });

  test("already-exists message ends with a period after the link", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: true,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: true,
        username: "myadmin",
      },
    });
    expect(html).toContain("users page</a>.");
  });

  test("does not render radio inputs when user exists", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: true,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: true,
        username: "admin",
      },
    });
    // Extract just the superuser form section
    const superuserStart = html.indexOf('id="settings-superuser"');
    const superuserEnd = html.indexOf("</form>", superuserStart) + 7;
    const superuserHtml = html.slice(superuserStart, superuserEnd);
    expect(superuserHtml).not.toContain('type="radio"');
  });

  test("submit button is NOT rendered in superuser form when user exists", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: true,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: true,
        username: "admin",
      },
    });
    const superuserStart = html.indexOf('id="settings-superuser"');
    const superuserEnd = html.indexOf("</form>", superuserStart) + 7;
    const superuserHtml = html.slice(superuserStart, superuserEnd);
    expect(superuserHtml).not.toContain('type="submit"');
    expect(superuserHtml).not.toContain("<button");
  });

  test("submit button IS rendered in superuser form when activated is false", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    const superuserStart = html.indexOf('id="settings-superuser"');
    const superuserEnd = html.indexOf("</form>", superuserStart) + 7;
    const superuserHtml = html.slice(superuserStart, superuserEnd);
    expect(superuserHtml).toContain('type="submit"');
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("adminSettingsPage > SuperuserForm placement", () => {
  test("SuperuserForm is placed immediately before ChangePasswordForm in DOM order", () => {
    const html = adminSettingsPage(TEST_SESSION, {
      ...defaultState(),
      superuser: {
        activated: false,
        available: true,
        choice: "",
        email: validEmail("admin@example.com"),
        userExists: false,
        username: "admin",
      },
    });
    const superuserIndex = html.indexOf("Superuser Recovery");
    const changePasswordIndex = html.indexOf("Change Password");
    expect(superuserIndex).toBeGreaterThan(-1);
    expect(changePasswordIndex).toBeGreaterThan(-1);
    expect(superuserIndex).toBeLessThan(changePasswordIndex);
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
    googleWalletConfigured: false,
    googleWalletIssuerId: "",
    googleWalletServiceAccountEmail: "",
    hostAppleWalletLabel: "",
    hostEmailLabel: "",
    hostGoogleWalletLabel: "",
    listingColumnOrder: "",
    paymentProvider: "",
    showPublicApi: false,
    smsGatewayBaseUrl: "",
    smsGatewayPassphraseConfigured: false,
    smsGatewayPasswordConfigured: false,
    smsGatewayUsername: "",
    smsGatewayWebhookConfigured: false,
    subdomainPreview: "",
    subdomainPreviewFullDomain: "",
    theme: "light",
  };

  test("renders the SMS gateway card with current values", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
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
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
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
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      bunnyCdnEnabled: true,
      paymentProvider: "square",
    });
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
  });

  test("subdomain form warns Stripe users about the webhook URL", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
      ...advancedDefaultState,
      bunnyDnsEnabled: true,
      paymentProvider: "stripe",
    });
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
  });

  test("does not warn about webhooks for providers without webhooks", () => {
    const html = adminAdvancedSettingsPage(TEST_SESSION, {
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
