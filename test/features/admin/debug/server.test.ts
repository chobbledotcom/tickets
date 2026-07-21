import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import { LIMIT_ENTRIES } from "#shared/limits.ts";
import { getRuntimeInfo } from "#shared/runtime.ts";
import { adminDebugPage } from "#templates/admin/debug.tsx";
import {
  assertAdminHtml,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import {
  generateGoogleTestCreds,
  generateTestCerts,
  getMismatchedAppleWalletKey,
} from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugOwnerSession, makeDebugState } from "#test-utils/debug.ts";
import { nonRsaCertificatePem } from "#test-utils/der.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";
import { activateStripe, enablePublicSite } from "#test-utils/settings.ts";

const debugRow = (label: string, value: string): string =>
  `<tr><td>${label}</td><td>${value}</td></tr>`;

const debugStatusRow = (label: string, configured: boolean): string =>
  debugRow(
    label,
    configured
      ? '<span class="badge-ok">Configured</span>'
      : '<span class="badge-missing">Not configured</span>',
  );

/** Store a complete Apple Wallet config with the requested signing key. */
const configureAppleDebug = async (
  signingKey = generateTestCerts().signingKey,
): Promise<void> => {
  const certs = generateTestCerts();
  await Promise.all([
    settings.update.appleWallet.passTypeId("pass.com.test.tickets"),
    settings.update.appleWallet.teamId("TESTTEAM01"),
    settings.update.appleWallet.signingCert(certs.signingCert),
    settings.update.appleWallet.signingKey(signingKey),
    settings.update.appleWallet.wwdrCert(certs.wwdrCert),
  ]);
};

describeWithEnv("server (admin debug)", { db: true }, () => {
  describe("GET /admin/debug", () => {
    testRequiresAuth("/admin/debug");

    test("renders debug page when authenticated", async () => {
      const response = await adminGet("/admin/debug");
      await expectHtmlResponse(response, 200, "Debug Info");
    });

    test("shows breadcrumb back to settings", async () => {
      await assertAdminHtml(
        "/admin/debug",
        'href="/admin/settings"',
        "Settings",
      );
    });

    test("shows Build section", async () => {
      await assertAdminHtml("/admin/debug", "Build", "Timestamp", "Commit");
    });

    test("shows Runtime section with version rows", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Runtime",
        "Host runtime",
        "Deno version",
        "V8 version",
        "TypeScript version",
        "Node compatibility",
        "OS / architecture",
        "User agent",
      );
    });

    test("shows the actual Deno version it is running on", async () => {
      const { denoVersion } = getRuntimeInfo();
      const html = await assertAdminHtml("/admin/debug", "Deno version");
      expect(html).toContain(denoVersion);
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
        debugRow("Pass Type ID", "—"),
        debugRow("Active source", "None"),
        debugRow("Signing certificate", "Not set"),
        debugRow("Signing key", "Not set"),
        debugRow("WWDR certificate", "Not set"),
      );
    });

    test("shows Payments section", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Payments",
        "Provider",
        "API key",
        "Webhook",
      );
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
      await assertAdminHtml("/admin/debug", "Notifications", "NTFY URL");
    });

    test("shows combined Bunny section with storage, CDN, and DNS", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Bunny",
        "File storage (images)",
        "CDN management",
        "CDN hostname",
        "Custom domain",
        "DNS subdomain",
        "Subdomain suffix",
        "Registered subdomain",
      );
    });

    test("shows combined Database &amp; Domain section", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Database &amp; Domain",
        "DB_URL",
        "Effective domain",
      );
    });

    test("does not expose secret keys or full URLs", async () => {
      const html = await assertAdminHtml("/admin/debug");
      expect(html).not.toContain("sk_test_");
      expect(html).not.toContain("sk_live_");
      expect(html).not.toContain("ntfy.sh");
    });

    test("shows exact empty and unconfigured values", async () => {
      using _env = withEnv({
        DB_URL: undefined,
        NTFY_URL: undefined,
        SENTRY_URL: undefined,
      });
      await settings.update.customDomain("hidden.example.test");
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Provider", "None"),
        debugRow("Mode", "—"),
        debugStatusRow("API key", false),
        debugStatusRow("Webhook", false),
        debugRow("From address", "—"),
        debugRow("Host provider (env)", "None"),
        debugStatusRow("NTFY URL", false),
        debugStatusRow("Sentry URL", false),
        debugRow("CDN hostname", "—"),
        debugRow("Custom domain", "—"),
        debugStatusRow("DB_URL", false),
        debugRow("Read-only from", "—"),
        debugStatusRow("Renewal URL", false),
      );
    });

    test("shows no secrets disclaimer", async () => {
      await assertAdminHtml("/admin/debug", "No secrets or keys are shown");
    });
  });

  describe("GET /admin/debug with Stripe configured", () => {
    test("shows stripe as provider with key and webhook status", async () => {
      await settings.update.paymentProvider("stripe");
      await activateStripe("whsec_fake", "we_fake", "sk_test_fake");
      await assertAdminHtml("/admin/debug", "stripe", "Configured");
    });

    test("shows Test mode for a test-prefixed key without leaking it", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.stripe.secretKey("sk_test_fake");
      const html = await assertAdminHtml("/admin/debug", "Mode", "Test");
      expect(html).not.toContain("sk_test_fake");
    });

    test("shows Live mode for a live-prefixed key", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.stripe.secretKey("sk_live_fake");
      const html = await assertAdminHtml("/admin/debug", "Live");
      expect(html).not.toContain("sk_live_fake");
    });

    test("shows an em dash for mode when no key is set", async () => {
      await settings.update.paymentProvider("stripe");
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Provider", "stripe"),
        debugRow("Mode", "—"),
        debugStatusRow("Webhook", false),
      );
    });
  });

  describe("GET /admin/debug with Square configured", () => {
    test("shows square as provider with webhook status", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.webhookSignatureKey("sig_fake");
      await assertAdminHtml("/admin/debug", "square");
    });

    test("shows Live mode when sandbox is disabled", async () => {
      await settings.update.paymentProvider("square");
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Provider", "square"),
        debugRow("Mode", "Live"),
        debugStatusRow("Webhook", false),
      );
    });

    test("shows Sandbox mode when sandbox is enabled", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.sandbox(true);
      await assertAdminHtml("/admin/debug", "square", "Mode", "Sandbox");
    });
  });

  describe("GET /admin/debug with SumUp configured", () => {
    test("shows sumup as provider with key and webhook status", async () => {
      await settings.update.paymentProvider("sumup");
      await settings.update.sumup.apiKey("sk_test_fake");
      await settings.update.sumup.merchantCode("MC_fake");
      await assertAdminHtml("/admin/debug", "sumup", "Configured");
    });

    test("shows Test mode for a test-prefixed SumUp key", async () => {
      await settings.update.paymentProvider("sumup");
      await settings.update.sumup.apiKey("sk_test_fake");
      await assertAdminHtml("/admin/debug", "sumup", "Mode", "Test");
    });
  });

  describe("GET /admin/debug with Apple Wallet DB config", () => {
    test("shows Database as source with valid cert status", async () => {
      await configureAppleDebug();
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Active source", "Database"),
        debugRow("Pass Type ID", "pass.com.test.tickets"),
        debugRow("Signing certificate", "Valid"),
        debugRow("Signing key", "Valid"),
        debugRow("WWDR certificate", "Valid"),
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
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Signing certificate", "Invalid PEM"),
        debugRow("Signing key", "Invalid PEM"),
        debugRow("WWDR certificate", "Invalid PEM"),
      );
    });

    test("shows a non-RSA WWDR intermediate as valid", async () => {
      await configureAppleDebug();
      await settings.update.appleWallet.wwdrCert(nonRsaCertificatePem());
      await assertAdminHtml(
        "/admin/debug",
        debugRow("WWDR certificate", "Valid"),
      );
    });

    test("shows a valid certificate beside an invalid key", async () => {
      await configureAppleDebug("not-a-valid-pem");
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Signing certificate", "Valid"),
        debugRow("Signing key", "Invalid PEM"),
      );
    });

    test("shows an invalid certificate beside a valid key", async () => {
      await configureAppleDebug();
      await settings.update.appleWallet.signingCert("not-a-valid-pem");
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Signing certificate", "Invalid PEM"),
        debugRow("Signing key", "Valid"),
      );
    });

    test("shows when the signing certificate and key do not match", async () => {
      await configureAppleDebug(getMismatchedAppleWalletKey());
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Signing certificate", "Does not match key"),
        debugRow("Signing key", "Does not match certificate"),
      );
    });
  });

  describe("GET /admin/debug with Apple Wallet env vars", () => {
    test("shows Environment variables as source when env configured", async () => {
      const certs = generateTestCerts();
      using _env = withEnv({
        APPLE_WALLET_PASS_TYPE_ID: "pass.com.env.test",
        APPLE_WALLET_SIGNING_CERT: certs.signingCert,
        APPLE_WALLET_SIGNING_KEY: certs.signingKey,
        APPLE_WALLET_TEAM_ID: "ENVTEAM01",
        APPLE_WALLET_WWDR_CERT: certs.wwdrCert,
      });
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Active source", "Environment variables"),
        debugRow("Pass Type ID", "pass.com.env.test"),
      );
    });
  });

  describe("GET /admin/debug with host email env vars", () => {
    test("shows host email provider when env configured", async () => {
      using _env = withEnv({
        HOST_EMAIL_API_KEY: "re_test_key",
        HOST_EMAIL_FROM_ADDRESS: "test@example.com",
        HOST_EMAIL_PROVIDER: "resend",
      });
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Host provider (env)", "resend"),
      );
    });
  });

  describe("GET /admin/debug with Google Wallet section", () => {
    test("shows Google Wallet section when unconfigured", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Google Wallet",
        debugRow("Issuer ID", "—"),
        debugRow("Active source", "None"),
        debugRow("Private key", "Not set"),
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
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Active source", "Database"),
        debugRow("Issuer ID", creds.issuerId),
        debugRow("Private key", "Valid"),
      );
    });

    test("shows Invalid key for bad private key data", async () => {
      await Promise.all([
        settings.update.googleWallet.issuerId("1234567890"),
        settings.update.googleWallet.serviceAccountEmail(
          "test@test.iam.gserviceaccount.com",
        ),
        settings.update.googleWallet.serviceAccountKey("not-a-valid-key"),
      ]);
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Private key", "Invalid key"),
      );
    });
  });

  describe("GET /admin/debug with Google Wallet env vars", () => {
    test("shows Environment variables as source when env configured", async () => {
      const creds = await generateGoogleTestCreds();
      using _env = withEnv({
        GOOGLE_WALLET_ISSUER_ID: "9876543210",
        GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "env@test.iam.gserviceaccount.com",
        GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: creds.serviceAccountKey,
      });
      await assertAdminHtml(
        "/admin/debug",
        debugRow("Active source", "Environment variables"),
        debugRow("Issuer ID", "9876543210"),
      );
    });
  });

  describe("GET /admin/debug with Bunny CDN enabled", () => {
    test("shows CDN as configured when Bunny CDN is enabled", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "99",
      });
      const original = bunnyCdnApi.getCdnHostname;
      bunnyCdnApi.getCdnHostname = () =>
        Promise.resolve({ hostname: "mysite.b-cdn.net", ok: true as const });
      try {
        await assertAdminHtml(
          "/admin/debug",
          "badge-ok",
          "CDN management",
          "mysite.b-cdn.net",
        );
      } finally {
        bunnyCdnApi.getCdnHostname = original;
      }
    });

    test("shows empty CDN hostname when edge script API fails", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_SCRIPT_ID: "99",
      });
      const original = bunnyCdnApi.getCdnHostname;
      bunnyCdnApi.getCdnHostname = () =>
        Promise.resolve({ error: "API error", ok: false as const });
      try {
        const html = await assertAdminHtml("/admin/debug", "badge-ok");
        expect(html).not.toContain("mysite.b-cdn.net");
      } finally {
        bunnyCdnApi.getCdnHostname = original;
      }
    });
  });

  describe("GET /admin/debug with Bunny storage backend", () => {
    test("shows Bunny CDN badge when storage zone is configured", async () => {
      using _env = withEnv({
        STORAGE_ZONE_KEY: "zone-key",
        STORAGE_ZONE_NAME: "my-zone",
      });
      await assertAdminHtml("/admin/debug", "Bunny CDN");
    });

    test("shows Local filesystem badge when local storage is configured", async () => {
      using _env = withEnv({
        LOCAL_STORAGE_PATH: "/tmp/test-storage",
      });
      await assertAdminHtml("/admin/debug", "Local filesystem");
    });
  });

  describe("GET /admin/debug with Bunny DNS enabled", () => {
    test("shows DNS subdomain as configured with suffix", async () => {
      using _env = withEnv({
        BUNNY_API_KEY: "test-key",
        BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
        BUNNY_DNS_ZONE_ID: "12345",
      });
      await assertAdminHtml("/admin/debug", "DNS subdomain", ".tickets");
    });

    test("shows registered subdomain when set", () => {
      const state = makeDebugState({
        bunny: {
          cdnEnabled: false,
          cdnHostname: "",
          customDomain: "",
          dnsEnabled: true,
          registeredSubdomain: "mylisting.example.com",
          storageBackend: "none",
          subdomainSuffix: ".tickets",
        },
      });
      const html = adminDebugPage(debugOwnerSession, state);
      expect(html).toContain("mylisting.example.com");
      expect(html).toContain(".tickets");
    });
  });

  describe("Site section", () => {
    test("shows site configuration rows with values from setup", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Site",
        "Public site",
        "Public API",
        "Contact form",
        "Spam protection",
        "Country",
        "Currency",
        "Timezone",
        "Booking fee",
        "GBP",
        "UTC",
        "0%",
      );
    });

    test("shows Hidden/Disabled badges when features are off", async () => {
      await assertAdminHtml("/admin/debug", "Hidden", "Disabled");
    });

    test("shows Visible/Enabled badges and the booking fee when features are on", async () => {
      await getTestSession();
      await Promise.all([
        enablePublicSite(),
        settings.update.showPublicApi(true),
        settings.update.contactFormEnabled(true),
        settings.update.bookingFee("2.5"),
      ]);
      await assertAdminHtml("/admin/debug", "Visible", "Enabled", "2.5%");
    });
  });

  describe("Site section with spam protection configured", () => {
    test("shows spam protection as configured when Botpoison keys are set", async () => {
      using _env = withEnv({
        BOTPOISON_PUBLIC_KEY: "test-public",
        BOTPOISON_SECRET_KEY: "test-secret",
      });
      await assertAdminHtml("/admin/debug", "Spam protection", "Configured");
    });
  });

  describe("Availability section", () => {
    test("shows Active write access by default", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Availability",
        "Write access",
        "Active",
        "Read-only from",
        "Renewal URL",
        "Server time (UTC)",
      );
    });
  });

  describe("Availability section with read-only mode", () => {
    test("shows Read-only state, the cutoff, and the renewal badge", async () => {
      using _env = withEnv({
        READ_ONLY_FROM: "2000-01-01T00:00:00Z",
        RENEWAL_URL: "https://example.com/renew",
      });
      await assertAdminHtml(
        "/admin/debug",
        "Read-only",
        "2000-01-01T00:00:00Z",
        "Configured",
      );
    });

    test("shows Expiring soon when within the warning window", async () => {
      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
      using _env = withEnv({ READ_ONLY_FROM: soon });
      await assertAdminHtml("/admin/debug", "Expiring soon");
    });
  });

  describe("Database schema section", () => {
    test("shows the schema hash and an up-to-date status", async () => {
      await assertAdminHtml(
        "/admin/debug",
        "Schema status",
        "Up to date",
        "Schema hash",
        SCHEMA_HASH,
      );
    });

    test("shows Out of sync and the hash when markers do not match", () => {
      const state = makeDebugState({
        database: {
          hostConfigured: true,
          schemaHash: "deadbeef",
          schemaInSync: false,
        },
      });
      const html = adminDebugPage(debugOwnerSession, state);
      expect(html).toContain("Out of sync");
      expect(html).toContain("deadbeef");
    });
  });

  describe("Database pruning section", () => {
    test("renders the most recent prune timestamp as ISO", async () => {
      // Set a recent timestamp so the request-handler's fire-and-forget
      // maybeRunPrunes() sees it as not-yet-due and doesn't overwrite.
      const ts = Date.now() - 1000;
      await settings.update.lastPrunedPayments(String(ts));
      await settings.update.lastPrunedSessions(String(ts));
      await settings.update.lastPrunedLogins(String(ts));
      await settings.update.lastPrunedStrings(String(ts));
      await settings.update.lastPrunedAddresses(String(ts));
      const expected = new Date(ts).toISOString();
      await assertAdminHtml("/admin/debug", "Database pruning", expected);
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
      const state = makeDebugState({
        limits: [
          {
            current: 200,
            defaultValue: 100,
            envKey: "TEST_LIMIT",
            label: "Test limit",
            unit: "bytes",
          },
        ],
      });
      const html = adminDebugPage(debugOwnerSession, state);
      expect(html).toContain("200B");
      expect(html).toContain("(overridden)");
    });
  });
});
