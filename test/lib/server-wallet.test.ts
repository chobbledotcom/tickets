import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import forge from "node-forge";
import { unzipSync } from "fflate";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  expectAdminRedirect,
  expectHtmlResponse,
  loginAsAdmin,
  mockFormRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";
import { handleRequest } from "#routes";
import {
  hasAppleWalletConfig,
  getAppleWalletPassTypeIdFromDb,
  getAppleWalletTeamIdFromDb,
  updateAppleWalletPassTypeId,
  updateAppleWalletTeamId,
  updateAppleWalletSigningCert,
  updateAppleWalletSigningKey,
  updateAppleWalletWwdrCert,
} from "#lib/db/settings.ts";

/** Generate self-signed test certificates */
const generateTestCerts = () => {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  const caCert = forge.pki.createCertificate();
  caCert.publicKey = keys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notAfter.getFullYear() + 1);
  const caAttrs = [{ name: "commonName", value: "Test WWDR CA" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: "basicConstraints", cA: true }]);
  caCert.sign(keys.privateKey, forge.md.sha256.create());

  const signingKeys = forge.pki.rsa.generateKeyPair(2048);
  const signingCert = forge.pki.createCertificate();
  signingCert.publicKey = signingKeys.publicKey;
  signingCert.serialNumber = "02";
  signingCert.validity.notBefore = new Date();
  signingCert.validity.notAfter = new Date();
  signingCert.validity.notAfter.setFullYear(signingCert.validity.notAfter.getFullYear() + 1);
  signingCert.setSubject([{ name: "commonName", value: "Test Pass Signing" }]);
  signingCert.setIssuer(caAttrs);
  signingCert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    signingCert: forge.pki.certificateToPem(signingCert),
    signingKey: forge.pki.privateKeyToPem(signingKeys.privateKey),
    wwdrCert: forge.pki.certificateToPem(caCert),
  };
};

/** Configure all Apple Wallet settings in the database */
const configureAppleWallet = async () => {
  const certs = generateTestCerts();
  await Promise.all([
    updateAppleWalletPassTypeId("pass.com.test.tickets"),
    updateAppleWalletTeamId("TESTTEAM01"),
    updateAppleWalletSigningCert(certs.signingCert),
    updateAppleWalletSigningKey(certs.signingKey),
    updateAppleWalletWwdrCert(certs.wwdrCert),
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
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");
    const response = await awaitTestRequest(`/wallet/${token}`);
    expect(response.status).toBe(404);
  });

  test("returns 404 for invalid token", async () => {
    await configureAppleWallet();
    const response = await awaitTestRequest("/wallet/nonexistent-token");
    expect(response.status).toBe(404);
  });

  test("returns 404 for multi-token request", async () => {
    await configureAppleWallet();
    const { token: a } = await createTestAttendeeWithToken("A", "a@test.com");
    const { token: b } = await createTestAttendeeWithToken("B", "b@test.com");
    const response = await awaitTestRequest(`/wallet/${a}+${b}`);
    expect(response.status).toBe(404);
  });

  test("returns pkpass with correct content type", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/wallet/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.apple.pkpass");
  });

  test("returns pkpass with cache-control headers", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/wallet/${token}`);
    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=3600");
  });

  test("returns pkpass with content-disposition header", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/wallet/${token}`);
    expect(response.headers.get("Content-Disposition")).toContain("ticket.pkpass");
  });

  test("pkpass is a valid ZIP containing pass.json, manifest.json, and signature", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");

    const response = await awaitTestRequest(`/wallet/${token}`);
    const body = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(body);

    expect(files["pass.json"]).toBeDefined();
    expect(files["manifest.json"]).toBeDefined();
    expect(files["signature"]).toBeDefined();
  });

  test("pass.json contains correct event data", async () => {
    await configureAppleWallet();
    const { event, token } = await createTestAttendeeWithToken("Alice", "alice@test.com", {
      date: "2026-06-15T19:00",
      location: "Town Hall",
    });

    const response = await awaitTestRequest(`/wallet/${token}`);
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
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).not.toContain("wallet-link");
    expect(body).not.toContain("Add to Apple Wallet");
  });

  test("shows wallet link when Apple Wallet is configured", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken("Alice", "alice@test.com");
    const response = await awaitTestRequest(`/t/${token}`);
    const body = await response.text();
    expect(body).toContain("wallet-link");
    expect(body).toContain("Add to Apple Wallet");
    expect(body).toContain(`/wallet/${token}`);
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
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "",
        apple_wallet_team_id: "TESTTEAM01",
        apple_wallet_signing_cert: certs.signingCert,
        apple_wallet_signing_key: certs.signingKey,
        apple_wallet_wwdr_cert: certs.wwdrCert,
        csrf_token: csrfToken,
      }, cookie),
    );
    await expectHtmlResponse(response, 400, "Pass Type ID is required");
  });

  test("requires Team ID", async () => {
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test",
        apple_wallet_team_id: "",
        apple_wallet_signing_cert: certs.signingCert,
        apple_wallet_signing_key: certs.signingKey,
        apple_wallet_wwdr_cert: certs.wwdrCert,
        csrf_token: csrfToken,
      }, cookie),
    );
    await expectHtmlResponse(response, 400, "Team ID is required");
  });

  test("requires signing certificate on initial setup", async () => {
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test",
        apple_wallet_team_id: "TESTTEAM01",
        apple_wallet_signing_cert: "",
        apple_wallet_signing_key: certs.signingKey,
        apple_wallet_wwdr_cert: certs.wwdrCert,
        csrf_token: csrfToken,
      }, cookie),
    );
    await expectHtmlResponse(response, 400, "Signing certificate is required");
  });

  test("requires signing key on initial setup", async () => {
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test",
        apple_wallet_team_id: "TESTTEAM01",
        apple_wallet_signing_cert: certs.signingCert,
        apple_wallet_signing_key: "",
        apple_wallet_wwdr_cert: certs.wwdrCert,
        csrf_token: csrfToken,
      }, cookie),
    );
    await expectHtmlResponse(response, 400, "Signing private key is required");
  });

  test("requires WWDR certificate on initial setup", async () => {
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test",
        apple_wallet_team_id: "TESTTEAM01",
        apple_wallet_signing_cert: certs.signingCert,
        apple_wallet_signing_key: certs.signingKey,
        apple_wallet_wwdr_cert: "",
        csrf_token: csrfToken,
      }, cookie),
    );
    await expectHtmlResponse(response, 400, "WWDR certificate is required");
  });

  test("saves all settings successfully", async () => {
    const certs = generateTestCerts();
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "pass.com.test.tickets",
        apple_wallet_team_id: "TESTTEAM01",
        apple_wallet_signing_cert: certs.signingCert,
        apple_wallet_signing_key: certs.signingKey,
        apple_wallet_wwdr_cert: certs.wwdrCert,
        csrf_token: csrfToken,
      }, cookie),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain("Apple Wallet settings updated");

    expect(await hasAppleWalletConfig()).toBe(true);
    expect(await getAppleWalletPassTypeIdFromDb()).toBe("pass.com.test.tickets");
    expect(await getAppleWalletTeamIdFromDb()).toBe("TESTTEAM01");
  });

  test("clears all settings when everything is empty", async () => {
    await configureAppleWallet();
    expect(await hasAppleWalletConfig()).toBe(true);

    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockFormRequest("/admin/settings/apple-wallet", {
        apple_wallet_pass_type_id: "",
        apple_wallet_team_id: "",
        apple_wallet_signing_cert: "",
        apple_wallet_signing_key: "",
        apple_wallet_wwdr_cert: "",
        csrf_token: csrfToken,
      }, cookie),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location")!;
    expect(decodeURIComponent(location.replaceAll("+", " "))).toContain("Apple Wallet configuration cleared");
    expect(await hasAppleWalletConfig()).toBe(false);
  });

  test("shows Apple Wallet section on settings page", async () => {
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings", { cookie });
    const body = await response.text();
    expect(body).toContain("Apple Wallet");
    expect(body).toContain("apple_wallet_pass_type_id");
  });

  test("shows masked values on settings page when configured", async () => {
    await configureAppleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings", { cookie });
    const body = await response.text();
    expect(body).toContain("pass.com.test.tickets");
    expect(body).toContain("TESTTEAM01");
    // Configured secrets should show mask sentinel
    expect(body).toContain("••••••••");
  });
});
