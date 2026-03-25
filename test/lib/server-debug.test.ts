import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#lib/db/settings.ts";
import { LIMIT_ENTRIES } from "#lib/limits.ts";
import { handleRequest } from "#routes";
import {
  adminDebugPage,
  type DebugPageState,
} from "#templates/admin/debug.tsx";
import {
  adminGet,
  assertAdminHtml,
  describeWithEnv,
  expectAdminRedirect,
  expectHtmlResponse,
  generateGoogleTestCreds,
  generateTestCerts,
  mockRequest,
  setTestEnv,
} from "#test-utils";

describeWithEnv("server (admin debug)", { db: true }, () => {
  describe("GET /admin/debug", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/debug"));
      expectAdminRedirect(response);
    });

    test("renders debug page when authenticated", async () => {
      const { response } = await adminGet("/admin/debug");
      await expectHtmlResponse(response, 200, "Debug Info");
    });

    test("shows breadcrumb back to settings", async () => {
      await assertAdminHtml("/admin/debug", 'href="/admin/settings"', "Settings");
    });

    test("shows Build section", async () => {
      await assertAdminHtml("/admin/debug", "Build", "Timestamp", "Commit");
    });

    test("shows Apple Wallet section", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Apple Wallet",
        "DB config",
        "Env var config",
        "Active source",
        "Pass Type ID",
      );
    });

    test("shows Apple Wallet cert validation as Not set when unconfigured", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Signing certificate",
        "Signing key",
        "WWDR certificate",
        "Not set",
      );
    });

    test("shows Payments section", async () => {
      await assertAdminHtml("/admin/debug", "Payments", "Provider", "API key", "Webhook");
    });

    test("shows Email section", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Email",
        "Provider (DB)",
        "From address",
        "Host provider (env)",
      );
    });

    test("shows Notifications section", async () => {
      await assertAdminHtml("/admin/debug", "Notifications (ntfy)", "NTFY URL");
    });

    test("shows Bunny Storage section", async () => {
      await assertAdminHtml("/admin/debug", "Bunny Storage (images)", "Storage zone");
    });

    test("shows Bunny CDN section", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Bunny CDN",
        "CDN management",
        "CDN hostname",
        "Custom domain",
      );
    });

    test("shows Database section", async () => {
      await assertAdminHtml("/admin/debug", "Database", "DB_URL");
    });

    test("shows Domain section with effective domain", async () => {
      await assertAdminHtml("/admin/debug", "Domain", "Effective Domain");
    });

    test("does not expose secret keys or full URLs", async () => {
      const html = await assertAdminHtml("/admin/debug");
      expect(html).not.toContain("sk_test_");
      expect(html).not.toContain("sk_live_");
      expect(html).not.toContain("ntfy.sh");
    });

    test("shows Configured/Not configured badges", async () => {
      await assertAdminHtml("/admin/debug", "Not configured");
    });

    test("shows no secrets disclaimer", async () => {
      await assertAdminHtml("/admin/debug", "No secrets or keys are shown");
    });
  });

  describe("GET /admin/debug with Stripe configured", () => {
    test("shows stripe as provider with key and webhook status", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.stripe.secretKey("sk_test_fake");
      await settings.update.stripe.webhookConfig({
        secret: "whsec_fake",
        endpointId: "we_fake",
      });
      await assertAdminHtml("/admin/debug", "stripe", "Configured");
    });
  });

  describe("GET /admin/debug with Square configured", () => {
    test("shows square as provider with webhook status", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.webhookSignatureKey("sig_fake");
      await assertAdminHtml("/admin/debug", "square");
    });
  });

  describe("GET /admin/debug with Apple Wallet DB config", () => {
    test("shows Database as source with valid cert status", async () => {
      const certs = generateTestCerts();
      await Promise.all([
        settings.update.appleWallet.passTypeId("pass.com.test.tickets"),
        settings.update.appleWallet.teamId("TESTTEAM01"),
        settings.update.appleWallet.signingCert(certs.signingCert),
        settings.update.appleWallet.signingKey(certs.signingKey),
        settings.update.appleWallet.wwdrCert(certs.wwdrCert),
      ]);
      await assertAdminHtml(
        "/admin/debug",
        "Database",
        "pass.com.test.tickets",
        "Valid",
      );
    });

    test("shows Invalid PEM for bad certificate data", async () => {
      await Promise.all([
        settings.update.appleWallet.passTypeId("pass.com.test.tickets"),
        settings.update.appleWallet.teamId("TESTTEAM01"),
        settings.update.appleWallet.signingCert("not-a-valid-pem"),
        settings.update.appleWallet.signingKey("not-a-valid-pem"),
        settings.update.appleWallet.wwdrCert("not-a-valid-pem"),
      ]);
      await assertAdminHtml("/admin/debug", "Invalid PEM");
    });
  });

  describe("GET /admin/debug with Apple Wallet env vars", () => {
    let restoreEnv: () => void;

    afterEach(() => restoreEnv());

    test("shows Environment variables as source when env configured", async () => {
      const certs = generateTestCerts();
      restoreEnv = setTestEnv({
        APPLE_WALLET_PASS_TYPE_ID: "pass.com.env.test",
        APPLE_WALLET_TEAM_ID: "ENVTEAM01",
        APPLE_WALLET_SIGNING_CERT: certs.signingCert,
        APPLE_WALLET_SIGNING_KEY: certs.signingKey,
        APPLE_WALLET_WWDR_CERT: certs.wwdrCert,
      });
      await assertAdminHtml(
        "/admin/debug",
        "Environment variables",
        "pass.com.env.test",
      );
    });
  });

  describe("GET /admin/debug with host email env vars", () => {
    let restoreEnv: () => void;

    afterEach(() => restoreEnv());

    test("shows host email provider when env configured", async () => {
      restoreEnv = setTestEnv({
        HOST_EMAIL_PROVIDER: "resend",
        HOST_EMAIL_API_KEY: "re_test_key",
        HOST_EMAIL_FROM_ADDRESS: "test@example.com",
      });
      await assertAdminHtml("/admin/debug", "resend");
    });
  });

  describe("GET /admin/debug with Google Wallet section", () => {
    test("shows Google Wallet section when unconfigured", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Google Wallet",
        "Issuer ID",
        "Private key",
        "Not set",
      );
    });
  });

  describe("GET /admin/debug with Google Wallet DB config", () => {
    test("shows Database as source with valid key status", async () => {
      const creds = await generateGoogleTestCreds();
      await Promise.all([
        settings.update.googleWallet.issuerId(creds.issuerId),
        settings.update.googleWallet.serviceAccountEmail(
          creds.serviceAccountEmail,
        ),
        settings.update.googleWallet.serviceAccountKey(creds.serviceAccountKey),
      ]);
      await assertAdminHtml("/admin/debug", "Database", creds.issuerId, "Valid");
    });

    test("shows Invalid key for bad private key data", async () => {
      await Promise.all([
        settings.update.googleWallet.issuerId("1234567890"),
        settings.update.googleWallet.serviceAccountEmail(
          "test@test.iam.gserviceaccount.com",
        ),
        settings.update.googleWallet.serviceAccountKey("not-a-valid-key"),
      ]);
      await assertAdminHtml("/admin/debug", "Invalid key");
    });
  });

  describe("GET /admin/debug with Google Wallet env vars", () => {
    let restoreEnv: () => void;

    afterEach(() => restoreEnv());

    test("shows Environment variables as source when env configured", async () => {
      const creds = await generateGoogleTestCreds();
      restoreEnv = setTestEnv({
        GOOGLE_WALLET_ISSUER_ID: "9876543210",
        GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "env@test.iam.gserviceaccount.com",
        GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: creds.serviceAccountKey,
      });
      await assertAdminHtml(
        "/admin/debug",
        "Environment variables",
        "9876543210",
      );
    });
  });

  describe("GET /admin/debug with Bunny CDN enabled", () => {
    let restoreEnv: () => void;

    afterEach(() => restoreEnv());

    test("shows CDN as configured when Bunny CDN is enabled", async () => {
      restoreEnv = setTestEnv({ BUNNY_API_KEY: "test-key" });
      await assertAdminHtml("/admin/debug", "badge-ok", "CDN management");
    });
  });

  describe("Limits section", () => {
    test("shows limits table with all entries", async () => {
      const html = await assertAdminHtml("/admin/debug", "Limits");
      for (const entry of LIMIT_ENTRIES) {
        expect(html).toContain(entry.envKey);
        expect(html).toContain(entry.label);
      }
    });

    test("shows overridden indicator when current differs from default", () => {
      const state: DebugPageState = {
        build: { timestamp: "", commit: "" },
        appleWallet: {
          dbConfigured: false,
          envConfigured: false,
          passTypeId: "",
          source: "",
          certValidation: {
            signingCert: "Not set",
            signingKey: "Not set",
            wwdrCert: "Not set",
          },
        },
        googleWallet: {
          dbConfigured: false,
          envConfigured: false,
          issuerId: "",
          source: "",
          privateKeyValid: "Not set",
        },
        payment: {
          provider: "",
          keyConfigured: false,
          webhookConfigured: false,
        },
        email: {
          provider: "",
          apiKeyConfigured: false,
          fromAddress: "",
          hostProvider: "",
        },
        ntfy: { configured: false },
        storage: { enabled: false },
        bunnyCdn: { enabled: false, cdnHostname: "", customDomain: "" },
        database: { hostConfigured: false },
        domain: "localhost",
        limits: [
          {
            label: "Test limit",
            envKey: "TEST_LIMIT",
            defaultValue: 100,
            current: 200,
            unit: "bytes",
          },
        ],
        theme: "light",
      };
      const session = { adminLevel: "owner" as const };
      const html = adminDebugPage(session, state);
      expect(html).toContain("200B");
      expect(html).toContain("(overridden)");
    });
  });
});
