import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import {
  getAppleWalletConfig,
  getAppleWalletPassTypeIdFromDb,
  getAppleWalletTeamIdFromDb,
  getHostAppleWalletConfig,
  hasAppleWalletConfig,
  hasAppleWalletDbConfig,
  updateAppleWalletPassTypeId,
  updateAppleWalletSigningCert,
  updateAppleWalletSigningKey,
  updateAppleWalletTeamId,
  updateAppleWalletWwdrCert,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  generateTestCerts,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Reuse cached certs for all wallet configuration */
const testCerts = generateTestCerts();

/** Configure all Apple Wallet settings in the database */
const configureAppleWallet = async () => {
  await Promise.all([
    updateAppleWalletPassTypeId("pass.com.test.tickets"),
    updateAppleWalletTeamId("TESTTEAM01"),
    updateAppleWalletSigningCert(testCerts.signingCert),
    updateAppleWalletSigningKey(testCerts.signingKey),
    updateAppleWalletWwdrCert(testCerts.wwdrCert),
  ]);
};

describe("wallet route (/wallet/:token)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("returns 404 when Apple Wallet is not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    expect(response.status).toBe(404);
  });

  test("returns 404 for invalid token", async () => {
    await configureAppleWallet();
    const response = await awaitTestRequest("/wallet/nonexistent-token.pkpass");
    expect(response.status).toBe(404);
  });

  test("returns 404 for multi-token request", async () => {
    await configureAppleWallet();
    const { token: a } = await createTestAttendeeWithToken("A", "a@test.com");
    const { token: b } = await createTestAttendeeWithToken("B", "b@test.com");
    const response = await awaitTestRequest(`/wallet/${a}+${b}.pkpass`);
    expect(response.status).toBe(404);
  });

  test("returns 404 without .pkpass extension", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/wallet/${token}`);
    expect(response.status).toBe(404);
  });

  test("returns pkpass with correct content type", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.apple.pkpass",
    );
  });

  test("returns pkpass with cache-control headers", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=3600");
  });

  test("returns pkpass with inline content-disposition for iOS compatibility", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toContain("inline");
    expect(disposition).toContain("ticket.pkpass");
  });

  test("returns pkpass with Content-Length header for iOS compatibility", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    const contentLength = response.headers.get("Content-Length");
    expect(contentLength).not.toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Number(contentLength)).toBe(body.byteLength);
  });

  test("pkpass is a valid ZIP containing pass.json, icons, manifest.json, and signature", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    const body = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(body);

    expect(files["pass.json"]).toBeDefined();
    expect(files["icon.png"]).toBeDefined();
    expect(files["icon@2x.png"]).toBeDefined();
    expect(files["icon@3x.png"]).toBeDefined();
    expect(files["manifest.json"]).toBeDefined();
    expect(files["signature"]).toBeDefined();
  });

  test("pass.json contains correct event data", async () => {
    await configureAppleWallet();
    const { event, token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        date: "2026-06-15T19:00",
        location: "Town Hall",
      },
    );

    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    const body = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(body);
    const passJson = JSON.parse(new TextDecoder().decode(files["pass.json"]!));

    expect(passJson.passTypeIdentifier).toBe("pass.com.test.tickets");
    expect(passJson.teamIdentifier).toBe("TESTTEAM01");
    expect(passJson.serialNumber).toBe(token);
    expect(passJson.eventTicket.primaryFields[0].value).toBe(event.name);
  });

  test("returns null for non-GET methods", async () => {
    const { routeWallet } = await import("#routes/wallet.ts");
    const request = new Request("http://localhost/wallet/some-token", {
      method: "POST",
    });
    const result = await routeWallet(request, "/wallet/some-token", "POST");
    expect(result).toBeNull();
  });
});

describe("ticket view wallet link", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("does not show wallet link when Apple Wallet is not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).not.toContain("wallet-link");
    expect(body).not.toContain("Add to Apple Wallet");
  });

  test("shows wallet link when Apple Wallet is configured", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("wallet-link");
    expect(body).toContain("Add to Apple Wallet");
    expect(body).toContain(`/wallet/${token}.pkpass`);
  });
});

describe("POST /admin/settings/apple-wallet", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  test("redirects to login when not authenticated", async () => {
    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test",
      }),
    );
    expectAdminRedirect(response);
  });

  test("requires Pass Type ID", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "Pass Type ID is required");
  });

  test("requires Team ID", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "Team ID is required");
  });

  test("requires signing certificate on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: "",
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "Signing certificate is required");
  });

  test("requires signing key on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: "",
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "Signing private key is required");
  });

  test("requires WWDR certificate on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: "",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(response, 400, "WWDR certificate is required");
  });

  test("rejects invalid PEM signing certificate", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: "not a valid cert",
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "Signing certificate is not a valid PEM certificate",
    );
  });

  test("rejects invalid PEM signing key", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: "not a valid key",
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "Signing private key is not a valid PEM private key",
    );
  });

  test("rejects invalid PEM WWDR certificate", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: "not a valid cert",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );
    await expectHtmlResponse(
      response,
      400,
      "WWDR certificate is not a valid PEM certificate",
    );
  });

  test("saves all settings successfully", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "pass.com.test.tickets",
          apple_wallet_team_id: "TESTTEAM01",
          apple_wallet_signing_cert: testCerts.signingCert,
          apple_wallet_signing_key: testCerts.signingKey,
          apple_wallet_wwdr_cert: testCerts.wwdrCert,
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
      "Apple Wallet settings updated",
    );

    expect(await hasAppleWalletConfig()).toBe(true);
    expect(await getAppleWalletPassTypeIdFromDb()).toBe(
      "pass.com.test.tickets",
    );
    expect(await getAppleWalletTeamIdFromDb()).toBe("TESTTEAM01");
  });

  test("clears all settings when everything is empty", async () => {
    await configureAppleWallet();
    expect(await hasAppleWalletConfig()).toBe(true);

    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/apple-wallet",
        {
          apple_wallet_pass_type_id: "",
          apple_wallet_team_id: "",
          apple_wallet_signing_cert: "",
          apple_wallet_signing_key: "",
          apple_wallet_wwdr_cert: "",
          csrf_token: csrfToken,
        },
        cookie,
      ),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain(
      "Apple Wallet configuration cleared",
    );
    expect(await hasAppleWalletConfig()).toBe(false);
  });

  test("shows Apple Wallet section with masked values when configured", async () => {
    await configureAppleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    // Section exists
    expect(body).toContain("Apple Wallet");
    expect(body).toContain("apple_wallet_pass_type_id");
    // Configured values shown
    expect(body).toContain("pass.com.test.tickets");
    expect(body).toContain("TESTTEAM01");
    // Secrets are masked
    expect(body).toContain("••••••••");
  });
});

const WALLET_ENV_KEYS = [
  "APPLE_WALLET_PASS_TYPE_ID",
  "APPLE_WALLET_TEAM_ID",
  "APPLE_WALLET_SIGNING_CERT",
  "APPLE_WALLET_SIGNING_KEY",
  "APPLE_WALLET_WWDR_CERT",
] as const;

/** Set all Apple Wallet env vars using cached test certificates */
const setWalletEnvVars = () => {
  Deno.env.set("APPLE_WALLET_PASS_TYPE_ID", "pass.com.env.tickets");
  Deno.env.set("APPLE_WALLET_TEAM_ID", "ENVTEAM001");
  Deno.env.set("APPLE_WALLET_SIGNING_CERT", testCerts.signingCert);
  Deno.env.set("APPLE_WALLET_SIGNING_KEY", testCerts.signingKey);
  Deno.env.set("APPLE_WALLET_WWDR_CERT", testCerts.wwdrCert);
};

/** Clear all Apple Wallet env vars */
const clearWalletEnvVars = () => {
  for (const key of WALLET_ENV_KEYS) Deno.env.delete(key);
};

describe("getHostAppleWalletConfig", () => {
  afterEach(() => {
    clearWalletEnvVars();
  });

  test("returns null when no env vars are set", () => {
    clearWalletEnvVars();
    expect(getHostAppleWalletConfig()).toBeNull();
  });

  test("returns null when only some env vars are set", () => {
    Deno.env.set("APPLE_WALLET_PASS_TYPE_ID", "pass.com.test");
    Deno.env.set("APPLE_WALLET_TEAM_ID", "TEAM01");
    expect(getHostAppleWalletConfig()).toBeNull();
  });

  test("returns config when all env vars are set", () => {
    setWalletEnvVars();
    const config = getHostAppleWalletConfig();
    expect(config).not.toBeNull();
    expect(config!.passTypeId).toBe("pass.com.env.tickets");
    expect(config!.teamId).toBe("ENVTEAM001");
    expect(config!.signingCert).toContain("BEGIN CERTIFICATE");
    expect(config!.signingKey).toContain("BEGIN RSA PRIVATE KEY");
    expect(config!.wwdrCert).toContain("BEGIN CERTIFICATE");
  });
});

describe("Apple Wallet env var fallback", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
    clearWalletEnvVars();
  });

  test("hasAppleWalletConfig returns true with env vars when DB not configured", async () => {
    setWalletEnvVars();
    expect(await hasAppleWalletDbConfig()).toBe(false);
    expect(await hasAppleWalletConfig()).toBe(true);
  });

  test("getAppleWalletConfig falls back to env vars when DB not configured", async () => {
    setWalletEnvVars();
    const config = await getAppleWalletConfig();
    expect(config).not.toBeNull();
    expect(config!.passTypeId).toBe("pass.com.env.tickets");
    expect(config!.teamId).toBe("ENVTEAM001");
  });

  test("getAppleWalletConfig prefers DB config over env vars", async () => {
    setWalletEnvVars();
    await configureAppleWallet();
    const config = await getAppleWalletConfig();
    expect(config).not.toBeNull();
    expect(config!.passTypeId).toBe("pass.com.test.tickets");
    expect(config!.teamId).toBe("TESTTEAM01");
  });

  test("wallet route works with env var config", async () => {
    setWalletEnvVars();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.apple.pkpass",
    );

    const body = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(body);
    const passJson = JSON.parse(new TextDecoder().decode(files["pass.json"]!));
    expect(passJson.passTypeIdentifier).toBe("pass.com.env.tickets");
    expect(passJson.teamIdentifier).toBe("ENVTEAM001");
  });

  test("ticket view shows wallet link with env var config", async () => {
    setWalletEnvVars();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("wallet-link");
    expect(body).toContain("Add to Apple Wallet");
  });

  test("settings page shows host Apple Wallet label when env vars configured", async () => {
    setWalletEnvVars();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Host env (pass.com.env.tickets)");
    expect(body).toContain("Currently using");
  });

  test("settings page shows overriding label when both DB and env configured", async () => {
    setWalletEnvVars();
    await configureAppleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Host env (pass.com.env.tickets)");
    expect(body).toContain("Overriding");
  });
});
