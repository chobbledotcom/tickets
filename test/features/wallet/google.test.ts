import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { expectHtml, expectRedirect } from "#test-utils/assertions.ts";
import { generateGoogleTestCreds } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { fetchAliceTicketPageBody } from "#test-utils/db-helpers/attendees.ts";
import {
  configureGoogleWallet,
  setGoogleWalletEnvVars,
} from "#test-utils/google-wallet.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  expectMultiTokenPass404,
  expectPassRouteIgnoresNonGet,
  expectWalletCacheControl,
  expectWalletPass404,
  walletAliceToken,
} from "#test-utils/wallet-passes.ts";

describeWithEnv("google wallet route (/gwallet/:token)", { db: true }, () => {
  beforeEach(() => {
    // Pre-build the once()-cached test credentials so no single test pays
    // the keygen cost mid-assertion.
    generateGoogleTestCreds();
  });

  test("returns 404 when Google Wallet is not configured", async () => {
    const token = await walletAliceToken();
    await expectWalletPass404(`/gwallet/${token}`);
  });

  test("returns 404 for invalid token", async () => {
    await configureGoogleWallet();
    await expectWalletPass404("/gwallet/nonexistent-token");
  });

  test("returns 404 for multi-token request", async () => {
    await configureGoogleWallet();
    await expectMultiTokenPass404(
      (first, second) => `/gwallet/${first}+${second}`,
    );
  });

  test("redirects to Google Wallet save URL", async () => {
    const token = await walletAliceToken(configureGoogleWallet);
    const response = await awaitTestRequest(`/gwallet/${token}`);
    expectRedirect(response, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  });

  test("redirect URL contains a valid JWT", async () => {
    const token = await walletAliceToken(configureGoogleWallet);
    const response = await awaitTestRequest(`/gwallet/${token}`);
    const location = expectRedirect(
      response,
      /^https:\/\/pay\.google\.com\/gp\/v\/save\//,
    );
    const jwt = location.replace("https://pay.google.com/gp/v/save/", "");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  test("returns cache-control headers", async () => {
    const token = await walletAliceToken(configureGoogleWallet);
    const response = await awaitTestRequest(`/gwallet/${token}`);
    expectWalletCacheControl(response);
  });

  test("returns null for non-GET methods", async () => {
    const { routeGoogleWallet } = await import("#routes/wallet/google.ts");
    await expectPassRouteIgnoresNonGet(
      routeGoogleWallet,
      "/gwallet/some-token",
    );
  });
});

describeWithEnv("ticket view google wallet link", { db: true }, () => {
  beforeEach(() => {
    generateGoogleTestCreds();
  });

  test("does not show google wallet link when not configured", async () => {
    const { body } = await fetchAliceTicketPageBody();
    assert(!body.includes("Google Wallet"));
  });

  test("shows google wallet link when configured", async () => {
    const token = await walletAliceToken(configureGoogleWallet);
    const response = await awaitTestRequest(`/t/${token}`);
    await expectHtml(response, {
      contains: ["Google Wallet", `/gwallet/${token}`],
    });
  });
});

describeWithEnv(
  "googleWallet.getHostConfig",
  {
    env: {
      GOOGLE_WALLET_ISSUER_ID: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: undefined,
    },
  },
  () => {
    test("returns null when no env vars are set", () => {
      expect(settings.googleWallet.hostConfig).toBeNull();
    });

    test("returns null when only some env vars are set", () => {
      Deno.env.set("GOOGLE_WALLET_ISSUER_ID", "123");
      expect(settings.googleWallet.hostConfig).toBeNull();
    });

    test("returns config when all env vars are set", async () => {
      using _env = setGoogleWalletEnvVars();
      const config = settings.googleWallet.hostConfig;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("9876543210");
      expect(config!.serviceAccountEmail).toBe(
        "env@env-project.iam.gserviceaccount.com",
      );
      assertStringIncludes(config!.serviceAccountKey, "BEGIN PRIVATE KEY");
    });
  },
);

describeWithEnv(
  "Google Wallet env var fallback",
  {
    db: true,
    env: {
      GOOGLE_WALLET_ISSUER_ID: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: undefined,
    },
  },
  () => {
    beforeEach(() => {
      generateGoogleTestCreds();
    });

    test("hasGoogleWalletConfig returns true with env vars when DB not configured", async () => {
      using _env = setGoogleWalletEnvVars();
      expect(settings.googleWallet.hasDbConfig).toBe(false);
      expect(settings.googleWallet.hasConfig).toBe(true);
    });

    test("getGoogleWalletConfig falls back to env vars when DB not configured", async () => {
      using _env = setGoogleWalletEnvVars();
      const config = settings.googleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("9876543210");
    });

    test("getGoogleWalletConfig prefers DB config over env vars", async () => {
      using _env = setGoogleWalletEnvVars();
      await configureGoogleWallet();
      const config = settings.googleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("1234567890");
    });

    test("gwallet route works with env var config", async () => {
      using _env = setGoogleWalletEnvVars();
      const token = await walletAliceToken();
      const response = await awaitTestRequest(`/gwallet/${token}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(
        /^https:\/\/pay\.google\.com\/gp\/v\/save\//,
      );
    });

    test("ticket view shows google wallet link with env var config", async () => {
      using _env = setGoogleWalletEnvVars();
      const token = await walletAliceToken();
      const response = await awaitTestRequest(`/t/${token}`);
      await expectHtml(response, { contains: ["Google Wallet"] });
    });
  },
);
