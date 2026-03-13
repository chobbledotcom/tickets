import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  getGoogleWalletConfig,
  getGoogleWalletIssuerIdFromDb,
  getGoogleWalletServiceAccountEmailFromDb,
  getHostGoogleWalletConfig,
  hasGoogleWalletConfig,
  hasGoogleWalletDbConfig,
  updateGoogleWalletIssuerId,
  updateGoogleWalletServiceAccountEmail,
  updateGoogleWalletServiceAccountKey,
} from "#lib/db/settings.ts";
import type { GoogleWalletCredentials } from "#lib/google-wallet.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  generateGoogleTestCreds,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Reuse cached creds for all wallet configuration */
let testCreds: GoogleWalletCredentials;

/** Configure all Google Wallet settings in the database */
const configureGoogleWallet = async () => {
  if (!testCreds) testCreds = await generateGoogleTestCreds();
  await Promise.all([
    updateGoogleWalletIssuerId(testCreds.issuerId),
    updateGoogleWalletServiceAccountEmail(testCreds.serviceAccountEmail),
    updateGoogleWalletServiceAccountKey(testCreds.serviceAccountKey),
  ]);
};

const ensureCreds = async () => {
  if (!testCreds) testCreds = await generateGoogleTestCreds();
};

describe("google wallet route (/gwallet/:token)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    await ensureCreds();
  });

  afterEach(() => {
    resetDb();
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
    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  });

  test("redirect URL contains a valid JWT", async () => {
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/gwallet/${token}`);
    const location = response.headers.get("Location")!;
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
    const { routeGoogleWallet } = await import("#routes/google-wallet.ts");
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

describe("ticket view google wallet link", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    await ensureCreds();
  });

  afterEach(() => {
    resetDb();
  });

  test("does not show google wallet link when not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).not.toContain("Add to Google Wallet");
  });

  test("shows google wallet link when configured", async () => {
    await configureGoogleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("Add to Google Wallet");
    expect(body).toContain(`/gwallet/${token}`);
  });
});

describe("POST /admin/settings/google-wallet", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    await ensureCreds();
  });

  afterEach(() => {
    resetDb();
  });

  test("redirects to login when not authenticated", async () => {
    const response = await handleRequest(
      mockFormRequest("/admin/settings/google-wallet", {
        google_wallet_issuer_id: "123",
      }),
    );
    expectAdminRedirect(response);
  });

  test("requires Issuer ID", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: testCreds.serviceAccountKey,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "Issuer ID is required");
  });

  test("requires Service Account Email", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key: testCreds.serviceAccountKey,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "Service account email is required",
    );
  });

  test("requires private key on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "Service account private key is required",
    );
  });

  test("rejects invalid PEM private key", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "not a valid key",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "Service account private key is not a valid PEM private key",
    );
  });

  test("saves all settings successfully", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: testCreds.serviceAccountKey,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
      "Google Wallet settings updated",
    );

    expect(await hasGoogleWalletConfig()).toBe(true);
    expect(await getGoogleWalletIssuerIdFromDb()).toBe("1234567890");
    expect(await getGoogleWalletServiceAccountEmailFromDb()).toBe(
      "test@test.iam.gserviceaccount.com",
    );
  });

  test("clears all settings when everything is empty", async () => {
    await configureGoogleWallet();
    expect(await hasGoogleWalletConfig()).toBe(true);

    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          google_wallet_issuer_id: "",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key: "",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
      "Google Wallet configuration cleared",
    );
    expect(await hasGoogleWalletDbConfig()).toBe(false);
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

const GOOGLE_WALLET_ENV_KEYS = [
  "GOOGLE_WALLET_ISSUER_ID",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
] as const;

/** Set all Google Wallet env vars */
const setGoogleWalletEnvVars = async () => {
  await ensureCreds();
  Deno.env.set("GOOGLE_WALLET_ISSUER_ID", "9876543210");
  Deno.env.set(
    "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL",
    "env@env-project.iam.gserviceaccount.com",
  );
  Deno.env.set(
    "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
    testCreds.serviceAccountKey,
  );
};

/** Clear all Google Wallet env vars */
const clearGoogleWalletEnvVars = () => {
  for (const key of GOOGLE_WALLET_ENV_KEYS) Deno.env.delete(key);
};

describe("getHostGoogleWalletConfig", () => {
  afterEach(() => {
    clearGoogleWalletEnvVars();
  });

  test("returns null when no env vars are set", () => {
    clearGoogleWalletEnvVars();
    expect(getHostGoogleWalletConfig()).toBeNull();
  });

  test("returns null when only some env vars are set", () => {
    Deno.env.set("GOOGLE_WALLET_ISSUER_ID", "123");
    expect(getHostGoogleWalletConfig()).toBeNull();
  });

  test("returns config when all env vars are set", async () => {
    await setGoogleWalletEnvVars();
    const config = getHostGoogleWalletConfig();
    expect(config).not.toBeNull();
    expect(config!.issuerId).toBe("9876543210");
    expect(config!.serviceAccountEmail).toBe(
      "env@env-project.iam.gserviceaccount.com",
    );
    expect(config!.serviceAccountKey).toContain("BEGIN PRIVATE KEY");
  });
});

describe("Google Wallet env var fallback", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
    await ensureCreds();
  });

  afterEach(() => {
    resetDb();
    clearGoogleWalletEnvVars();
  });

  test("hasGoogleWalletConfig returns true with env vars when DB not configured", async () => {
    await setGoogleWalletEnvVars();
    expect(await hasGoogleWalletDbConfig()).toBe(false);
    expect(await hasGoogleWalletConfig()).toBe(true);
  });

  test("getGoogleWalletConfig falls back to env vars when DB not configured", async () => {
    await setGoogleWalletEnvVars();
    const config = await getGoogleWalletConfig();
    expect(config).not.toBeNull();
    expect(config!.issuerId).toBe("9876543210");
  });

  test("getGoogleWalletConfig prefers DB config over env vars", async () => {
    await setGoogleWalletEnvVars();
    await configureGoogleWallet();
    const config = await getGoogleWalletConfig();
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
    const body = await response.text();
    expect(body).toContain("Add to Google Wallet");
  });

  test("settings page shows host Google Wallet label when env vars configured", async () => {
    await setGoogleWalletEnvVars();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Host env (9876543210)");
    expect(body).toContain("Currently using");
  });

  test("settings page shows overriding label when both DB and env configured", async () => {
    await setGoogleWalletEnvVars();
    await configureGoogleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Host env (9876543210)");
    expect(body).toContain("Overriding");
  });
});
