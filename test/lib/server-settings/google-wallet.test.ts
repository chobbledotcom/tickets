import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  describeWithEnv,
  expectFlashRedirect,
  expectHtml,
  expectRedirect,
  loginAsAdmin,
  mockFormRequest,
  setTestEnv,
  testRequiresAuth,
} from "#test-utils";
import { generateGoogleTestCreds } from "#test-utils/crypto.ts";

/** Configure all Google Wallet settings in the database */
const configureGoogleWallet = async () => {
  const creds = generateGoogleTestCreds();
  await Promise.all([
    settings.update.googleWallet.issuerId(creds.issuerId),
    settings.update.googleWallet.serviceAccountEmail(creds.serviceAccountEmail),
    settings.update.googleWallet.serviceAccountKey(creds.serviceAccountKey),
  ]);
};

const ensureCreds = (): void => {
  generateGoogleTestCreds();
};

describeWithEnv("google wallet route (/gwallet/:token)", { db: true }, () => {
  beforeEach(async () => {
    await ensureCreds();
  });

  test("returns 404 when Google Wallet is not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/gwallet/${token}`);
    expect(response.status).toBe(404);
  });

  test("returns 404 for invalid token", async () => {
    await configureGoogleWallet();
    const response = await awaitTestRequest("/gwallet/nonexistent-token");
    expect(response.status).toBe(404);
  });

  test("returns 404 for multi-token request", async () => {
    await configureGoogleWallet();
    const { token: a } = await createTestAttendeeWithToken("A", "a@test.com");
    const { token: b } = await createTestAttendeeWithToken("B", "b@test.com");
    const response = await awaitTestRequest(`/gwallet/${a}+${b}`);
    expect(response.status).toBe(404);
  });

  test("redirects to Google Wallet save URL", async () => {
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/gwallet/${token}`);
    expectRedirect(response, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  });

  test("redirect URL contains a valid JWT", async () => {
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

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
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/gwallet/${token}`);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=3600");
  });

  test("returns null for non-GET methods", async () => {
    const { routeGoogleWallet } = await import("#routes/wallet/google.ts");
    const request = new Request("http://localhost/gwallet/some-token", {
      method: "POST",
    });
    const result = await routeGoogleWallet(
      request,
      "/gwallet/some-token",
      "POST",
    );
    expect(result).toBeNull();
  });
});

describeWithEnv("ticket view google wallet link", { db: true }, () => {
  beforeEach(async () => {
    await ensureCreds();
  });

  test("does not show google wallet link when not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).not.toContain("Google Wallet");
  });

  test("shows google wallet link when configured", async () => {
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    await expectHtml(response, {
      contains: ["Google Wallet", `/gwallet/${token}`],
    });
  });
});

describeWithEnv("POST /admin/settings/google-wallet", { db: true }, () => {
  beforeEach(async () => {
    await ensureCreds();
  });

  testRequiresAuth("/admin/settings/google-wallet", {
    body: {
      google_wallet_issuer_id: "123",
    },
    method: "POST",
  });

  test("requires Issuer ID", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Issuer ID is required"),
      false,
    )(response);
  });

  test("requires Service Account Email", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Service account email is required"),
      false,
    )(response);
  });

  test("requires private key on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "",
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Service account private key is required"),
      false,
    )(response);
  });

  test("rejects invalid PEM private key", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "not a valid key",
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining(
        "Service account private key is not a valid PEM private key",
      ),
      false,
    )(response);
  });

  test("saves all settings successfully", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      "Google Wallet configuration updated",
    )(response);

    expect(settings.googleWallet.hasConfig).toBe(true);
    expect(settings.googleWallet.issuerId).toBe("1234567890");
    expect(settings.googleWallet.serviceAccountEmail).toBe(
      "test@test.iam.gserviceaccount.com",
    );
  });

  test("clears all settings when everything is empty", async () => {
    await configureGoogleWallet();
    expect(settings.googleWallet.hasConfig).toBe(true);

    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key: "",
        },
        cookie,
      ),
    );

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      "Google Wallet configuration cleared",
    )(response);
    expect(settings.googleWallet.hasDbConfig).toBe(false);
  });

  test("shows Google Wallet section with values when configured", async () => {
    await configureGoogleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Google Wallet");
    expect(body).toContain("google_wallet_issuer_id");
    expect(body).toContain("1234567890");
    expect(body).toContain("test@test-project.iam.gserviceaccount.com");
    // Secret is masked
    expect(body).toContain("••••••••");
  });
});

/** Set all Google Wallet env vars and return restore function */
const setGoogleWalletEnvVars = async () => {
  await ensureCreds();
  return setTestEnv({
    GOOGLE_WALLET_ISSUER_ID: "9876543210",
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:
      "env@env-project.iam.gserviceaccount.com",
    GOOGLE_WALLET_SERVICE_ACCOUNT_KEY:
      generateGoogleTestCreds().serviceAccountKey,
  });
};

describeWithEnv(
  "getHostGoogleWalletConfig",
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
      await setGoogleWalletEnvVars();
      const config = settings.googleWallet.hostConfig;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("9876543210");
      expect(config!.serviceAccountEmail).toBe(
        "env@env-project.iam.gserviceaccount.com",
      );
      expect(config!.serviceAccountKey).toContain("BEGIN PRIVATE KEY");
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
    beforeEach(async () => {
      await ensureCreds();
    });

    test("hasGoogleWalletConfig returns true with env vars when DB not configured", async () => {
      await setGoogleWalletEnvVars();
      expect(settings.googleWallet.hasDbConfig).toBe(false);
      expect(settings.googleWallet.hasConfig).toBe(true);
    });

    test("getGoogleWalletConfig falls back to env vars when DB not configured", async () => {
      await setGoogleWalletEnvVars();
      const config = settings.googleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("9876543210");
    });

    test("getGoogleWalletConfig prefers DB config over env vars", async () => {
      await setGoogleWalletEnvVars();
      await configureGoogleWallet();
      const config = settings.googleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.issuerId).toBe("1234567890");
    });

    test("gwallet route works with env var config", async () => {
      await setGoogleWalletEnvVars();
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );
      const response = await awaitTestRequest(`/gwallet/${token}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toMatch(
        /^https:\/\/pay\.google\.com\/gp\/v\/save\//,
      );
    });

    test("ticket view shows google wallet link with env var config", async () => {
      await setGoogleWalletEnvVars();
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );
      const response = await awaitTestRequest(`/t/${token}`);
      await expectHtml(response, { contains: ["Google Wallet"] });
    });

    test("settings page shows host Google Wallet label when env vars configured", async () => {
      await setGoogleWalletEnvVars();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie,
      });
      await expectHtml(response, {
        contains: ["Host env (9876543210)", "Currently using"],
      });
    });

    test("settings page shows overriding label when both DB and env configured", async () => {
      await setGoogleWalletEnvVars();
      await configureGoogleWallet();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie,
      });
      await expectHtml(response, {
        contains: ["Host env (9876543210)", "Overriding"],
      });
    });
  },
);
