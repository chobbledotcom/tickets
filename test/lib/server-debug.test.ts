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
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain('href="/admin/settings"');
      expect(html).toContain("Settings");
    });

    test("shows Build section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Build");
      expect(html).toContain("Timestamp");
      expect(html).toContain("Commit");
    });

    test("shows Apple Wallet section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Apple Wallet");
      expect(html).toContain("DB config");
      expect(html).toContain("Env var config");
      expect(html).toContain("Active source");
      expect(html).toContain("Pass Type ID");
    });

    test("shows Apple Wallet cert validation as Not set when unconfigured", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Signing certificate");
      expect(html).toContain("Signing key");
      expect(html).toContain("WWDR certificate");
      expect(html).toContain("Not set");
    });

    test("shows Payments section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Payments");
      expect(html).toContain("Provider");
      expect(html).toContain("API key");
      expect(html).toContain("Webhook");
    });

    test("shows Email section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Email");
      expect(html).toContain("Provider (DB)");
      expect(html).toContain("From address");
      expect(html).toContain("Host provider (env)");
    });

    test("shows Notifications section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Notifications (ntfy)");
      expect(html).toContain("NTFY URL");
    });

    test("shows Bunny Storage section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Bunny Storage (images)");
      expect(html).toContain("Storage zone");
    });

    test("shows Bunny CDN section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Bunny CDN");
      expect(html).toContain("CDN management");
      expect(html).toContain("CDN hostname");
      expect(html).toContain("Custom domain");
    });

    test("shows Database section", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Database");
      expect(html).toContain("DB_URL");
    });

    test("shows Domain section with ALLOWED_DOMAIN", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Domain");
      expect(html).toContain("ALLOWED_DOMAIN");
    });

    test("does not expose secret keys or full URLs", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).not.toContain("sk_test_");
      expect(html).not.toContain("sk_live_");
      expect(html).not.toContain("ntfy.sh");
    });

    test("shows Configured/Not configured badges", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Not configured");
    });

    test("shows no secrets disclaimer", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("No secrets or keys are shown");
    });
  });

  describe("GET /admin/debug with Stripe configured", () => {
    test("shows stripe as provider with key and webhook status", async () => {
      await settings.paymentProvider.set("stripe");
      await settings.stripe.secretKey.update("sk_test_fake");
      await settings.stripe.setWebhookConfig({
        secret: "whsec_fake",
        endpointId: "we_fake",
      });
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("stripe");
      expect(html).toContain("Configured");
    });
  });

  describe("GET /admin/debug with Square configured", () => {
    test("shows square as provider with webhook status", async () => {
      await settings.paymentProvider.set("square");
      await settings.square.webhookSignatureKey.update("sig_fake");
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("square");
    });
  });

  describe("GET /admin/debug with Apple Wallet DB config", () => {
    test("shows Database as source with valid cert status", async () => {
      const certs = generateTestCerts();
      await Promise.all([
        settings.appleWallet.passTypeId.update("pass.com.test.tickets"),
        settings.appleWallet.teamId.update("TESTTEAM01"),
        settings.appleWallet.signingCert.update(certs.signingCert),
        settings.appleWallet.signingKey.update(certs.signingKey),
        settings.appleWallet.wwdrCert.update(certs.wwdrCert),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Database");
      expect(html).toContain("pass.com.test.tickets");
      expect(html).toContain("Valid");
    });

    test("shows Invalid PEM for bad certificate data", async () => {
      await Promise.all([
        settings.appleWallet.passTypeId.update("pass.com.test.tickets"),
        settings.appleWallet.teamId.update("TESTTEAM01"),
        settings.appleWallet.signingCert.update("not-a-valid-pem"),
        settings.appleWallet.signingKey.update("not-a-valid-pem"),
        settings.appleWallet.wwdrCert.update("not-a-valid-pem"),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Invalid PEM");
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
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Environment variables");
      expect(html).toContain("pass.com.env.test");
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
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("resend");
    });
  });

  describe("GET /admin/debug with Google Wallet section", () => {
    test("shows Google Wallet section when unconfigured", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Google Wallet");
      expect(html).toContain("Issuer ID");
      expect(html).toContain("Private key");
      expect(html).toContain("Not set");
    });
  });

  describe("GET /admin/debug with Google Wallet DB config", () => {
    test("shows Database as source with valid key status", async () => {
      const creds = await generateGoogleTestCreds();
      await Promise.all([
        settings.googleWallet.issuerId.update(creds.issuerId),
        settings.googleWallet.serviceAccountEmail.update(
          creds.serviceAccountEmail,
        ),
        settings.googleWallet.serviceAccountKey.update(creds.serviceAccountKey),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Database");
      expect(html).toContain(creds.issuerId);
      expect(html).toContain("Valid");
    });

    test("shows Invalid key for bad private key data", async () => {
      await Promise.all([
        settings.googleWallet.issuerId.update("1234567890"),
        settings.googleWallet.serviceAccountEmail.update(
          "test@test.iam.gserviceaccount.com",
        ),
        settings.googleWallet.serviceAccountKey.update("not-a-valid-key"),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Invalid key");
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
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Environment variables");
      expect(html).toContain("9876543210");
    });
  });

  describe("GET /admin/debug with Bunny CDN enabled", () => {
    let restoreEnv: () => void;

    afterEach(() => restoreEnv());

    test("shows CDN as configured when Bunny CDN is enabled", async () => {
      restoreEnv = setTestEnv({ BUNNY_API_KEY: "test-key" });
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("badge-ok");
      expect(html).toContain("CDN management");
    });
  });

  describe("Limits section", () => {
    test("shows limits table with all entries", async () => {
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Limits");
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
