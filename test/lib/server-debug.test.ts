import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  setPaymentProvider,
  setStripeWebhookConfig,
  updateAppleWalletPassTypeId,
  updateAppleWalletSigningCert,
  updateAppleWalletSigningKey,
  updateAppleWalletTeamId,
  updateAppleWalletWwdrCert,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  adminGet,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  generateTestCerts,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("server (admin debug)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

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
      await setPaymentProvider("stripe");
      await updateStripeKey("sk_test_fake");
      await setStripeWebhookConfig({
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
      await setPaymentProvider("square");
      await updateSquareWebhookSignatureKey("sig_fake");
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("square");
    });
  });

  describe("GET /admin/debug with Apple Wallet DB config", () => {
    test("shows Database as source with valid cert status", async () => {
      const certs = generateTestCerts();
      await Promise.all([
        updateAppleWalletPassTypeId("pass.com.test.tickets"),
        updateAppleWalletTeamId("TESTTEAM01"),
        updateAppleWalletSigningCert(certs.signingCert),
        updateAppleWalletSigningKey(certs.signingKey),
        updateAppleWalletWwdrCert(certs.wwdrCert),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Database");
      expect(html).toContain("pass.com.test.tickets");
      expect(html).toContain("Valid");
    });

    test("shows Invalid PEM for bad certificate data", async () => {
      await Promise.all([
        updateAppleWalletPassTypeId("pass.com.test.tickets"),
        updateAppleWalletTeamId("TESTTEAM01"),
        updateAppleWalletSigningCert("not-a-valid-pem"),
        updateAppleWalletSigningKey("not-a-valid-pem"),
        updateAppleWalletWwdrCert("not-a-valid-pem"),
      ]);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Invalid PEM");
    });
  });

  describe("GET /admin/debug with Apple Wallet env vars", () => {
    const envKeys = [
      "APPLE_WALLET_PASS_TYPE_ID",
      "APPLE_WALLET_TEAM_ID",
      "APPLE_WALLET_SIGNING_CERT",
      "APPLE_WALLET_SIGNING_KEY",
      "APPLE_WALLET_WWDR_CERT",
    ] as const;

    const origValues = envKeys.map((k) => [k, Deno.env.get(k)] as const);

    afterEach(() => {
      for (const [key, val] of origValues) {
        if (val) Deno.env.set(key, val);
        else Deno.env.delete(key);
      }
    });

    test("shows Environment variables as source when env configured", async () => {
      const certs = generateTestCerts();
      Deno.env.set("APPLE_WALLET_PASS_TYPE_ID", "pass.com.env.test");
      Deno.env.set("APPLE_WALLET_TEAM_ID", "ENVTEAM01");
      Deno.env.set("APPLE_WALLET_SIGNING_CERT", certs.signingCert);
      Deno.env.set("APPLE_WALLET_SIGNING_KEY", certs.signingKey);
      Deno.env.set("APPLE_WALLET_WWDR_CERT", certs.wwdrCert);
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("Environment variables");
      expect(html).toContain("pass.com.env.test");
    });
  });

  describe("GET /admin/debug with host email env vars", () => {
    const envKeys = [
      "HOST_EMAIL_PROVIDER",
      "HOST_EMAIL_API_KEY",
      "HOST_EMAIL_FROM_ADDRESS",
    ] as const;

    const origValues = envKeys.map((k) => [k, Deno.env.get(k)] as const);

    afterEach(() => {
      for (const [key, val] of origValues) {
        if (val) Deno.env.set(key, val);
        else Deno.env.delete(key);
      }
    });

    test("shows host email provider when env configured", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "resend");
      Deno.env.set("HOST_EMAIL_API_KEY", "re_test_key");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "test@example.com");
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("resend");
    });
  });

  describe("GET /admin/debug with Bunny CDN enabled", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
    });

    test("shows CDN as configured when Bunny CDN is enabled", async () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      const { response } = await adminGet("/admin/debug");
      const html = await response.text();
      expect(html).toContain("badge-ok");
      expect(html).toContain("CDN management");
    });
  });
});
