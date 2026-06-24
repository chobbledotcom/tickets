import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  createTestAttendeeWithToken,
  describeWithEnv,
  expectFlashRedirect,
  getHeader,
  mockFormRequest,
  setTestEnv,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";
import { configureAppleWallet, generateTestCerts } from "#test-utils/crypto.ts";

/** Reuse cached certs for all wallet configuration */
const testCerts = generateTestCerts();

/** Submit Apple Wallet settings form with overrides applied to valid defaults */
const submitWalletSettingsForm = async (
  overrides: Record<string, string> = {},
) => {
  const defaults: Record<string, string> = {
    apple_wallet_pass_type_id: "pass.com.test",
    apple_wallet_signing_cert: testCerts.signingCert,
    apple_wallet_signing_key: testCerts.signingKey,
    apple_wallet_team_id: "TESTTEAM01",
    apple_wallet_wwdr_cert: testCerts.wwdrCert,
    csrf_token: await testCsrfToken(),
  };
  return handleRequest(
    mockFormRequest(
      "/admin/settings/apple-wallet",
      { ...defaults, ...overrides },
      await testCookie(),
    ),
  );
};

/** Fetch a pkpass response for a given token (configure wallet first) */
const fetchPkpassResponse = (token: string) =>
  awaitTestRequest(`/wallet/${token}.pkpass`);

/** Fetch and parse pass.json from a pkpass response */
// deno-lint-ignore no-explicit-any
const parsePkpassJson = async (token: string): Promise<Record<string, any>> => {
  const response = await fetchPkpassResponse(token);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(bytes);
  return JSON.parse(new TextDecoder().decode(files["pass.json"]!));
};

/** Fetch a ticket page and return the HTML body */
const fetchWalletTicketBody = async (token: string): Promise<string> => {
  const response = await awaitTestRequest(`/t/${token}`);
  return response.text();
};

/** Create a test attendee, fetch pkpass, and assert 200 with correct content type */
const fetchValidPkpassForNewAttendee = async () => {
  const { token } = await createTestAttendeeWithToken(
    "Alice",
    "alice@test.com",
  );
  const response = await fetchPkpassResponse(token);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(
    "application/vnd.apple.pkpass",
  );
  return { response, token };
};

describeWithEnv("wallet route (/wallet/:token)", { db: true }, () => {
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

  test("returns 404 for orphaned attendee with no listing links", async () => {
    await configureAppleWallet();
    const { token, attendee } = await createTestAttendeeWithToken(
      "Orphan",
      "orphan@test.com",
    );
    const { getDb } = await import("#shared/db/client.ts");
    await getDb().execute({
      args: [attendee.id],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });
    const response = await awaitTestRequest(`/wallet/${token}.pkpass`);
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
    await fetchValidPkpassForNewAttendee();
  });

  test("returns pkpass with cache-control headers", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await fetchPkpassResponse(token);
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

    const response = await fetchPkpassResponse(token);
    const disposition = getHeader(response, "Content-Disposition");
    expect(disposition).toContain("inline");
    expect(disposition).toContain("ticket.pkpass");
  });

  test("returns pkpass with Content-Length header for iOS compatibility", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await fetchPkpassResponse(token);
    const contentLength = response.headers.get("Content-Length");
    expect(contentLength).not.toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Number(contentLength)).toBe(body.byteLength);
  });

  test("pkpass is a valid ZIP containing pass.json, manifest.json, and signature", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );

    const response = await fetchPkpassResponse(token);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const files = unzipSync(bytes);

    expect(files["pass.json"]).toBeDefined();
    expect(files["manifest.json"]).toBeDefined();
    expect(files.signature).toBeDefined();
  });

  test("pass.json contains correct listing data", async () => {
    await configureAppleWallet();
    const { listing, token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
      {
        date: "2026-06-15T19:00",
        location: "Town Hall",
      },
    );

    const passJson = await parsePkpassJson(token);

    expect(passJson.passTypeIdentifier).toBe("pass.com.test.tickets");
    expect(passJson.teamIdentifier).toBe("TESTTEAM01");
    expect(passJson.serialNumber).toBe(token);
    expect(passJson.listingTicket.primaryFields[0].value).toBe(listing.name);
  });

  test("pass.json includes webServiceURL and authenticationToken for auto-updates", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const passJson = await parsePkpassJson(token);
    expect(passJson.webServiceURL).toBe("https://localhost");
    expect(passJson.authenticationToken).toBe(token.padEnd(16, "-"));
    expect(passJson.authenticationToken.length).toBeGreaterThanOrEqual(16);
  });

  test("returns null for non-GET methods", async () => {
    const { routeWallet } = await import("#routes/wallet/index.ts");
    const request = new Request("http://localhost/wallet/some-token", {
      method: "POST",
    });
    const result = await routeWallet(request, "/wallet/some-token", "POST");
    expect(result).toBeNull();
  });
});

describeWithEnv("ticket view wallet link", { db: true }, () => {
  test("does not show wallet link when Apple Wallet is not configured", async () => {
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const body = await fetchWalletTicketBody(token);
    expect(body).not.toContain("wallet-link");
    expect(body).not.toContain("Apple Wallet");
  });

  test("shows wallet link when Apple Wallet is configured", async () => {
    await configureAppleWallet();
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@test.com",
    );
    const body = await fetchWalletTicketBody(token);
    expect(body).toContain("wallet-link");
    expect(body).toContain("Apple Wallet");
    expect(body).toContain(`/wallet/${token}.pkpass`);
  });
});

describeWithEnv("POST /admin/settings/apple-wallet", { db: true }, () => {
  testRequiresAuth("/admin/settings/apple-wallet", {
    body: {
      apple_wallet_pass_type_id: "pass.com.test",
    },
    method: "POST",
  });

  test("requires Pass Type ID", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_pass_type_id: "",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining("Pass Type ID is required"),
      false,
    )(response);
  });

  test("requires Team ID", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_team_id: "",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining("Team ID is required"),
      false,
    )(response);
  });

  test("requires signing certificate on initial setup", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_signing_cert: "",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining("Signing certificate is required"),
      false,
    )(response);
  });

  test("requires signing key on initial setup", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_signing_key: "",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining("Signing private key is required"),
      false,
    )(response);
  });

  test("requires WWDR certificate on initial setup", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_wwdr_cert: "",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining("WWDR certificate is required"),
      false,
    )(response);
  });

  test("rejects invalid PEM signing certificate", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_signing_cert: "not a valid cert",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining(
        "Signing certificate is not a valid PEM certificate",
      ),
      false,
    )(response);
  });

  test("rejects invalid PEM signing key", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_signing_key: "not a valid key",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining(
        "Signing private key is not a valid PEM private key",
      ),
      false,
    )(response);
  });

  test("rejects invalid PEM WWDR certificate", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_wwdr_cert: "not a valid cert",
    });
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      expect.stringContaining(
        "WWDR certificate is not a valid PEM certificate",
      ),
      false,
    )(response);
  });

  test("saves all settings successfully", async () => {
    const response = await submitWalletSettingsForm({
      apple_wallet_pass_type_id: "pass.com.test.tickets",
    });

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      "Apple Wallet configuration updated",
    )(response);

    expect(settings.appleWallet.hasConfig).toBe(true);
    expect(settings.appleWallet.passTypeId).toBe("pass.com.test.tickets");
    expect(settings.appleWallet.teamId).toBe("TESTTEAM01");
  });

  test("clears all settings when everything is empty", async () => {
    await configureAppleWallet();
    expect(settings.appleWallet.hasConfig).toBe(true);

    const response = await submitWalletSettingsForm({
      apple_wallet_pass_type_id: "",
      apple_wallet_signing_cert: "",
      apple_wallet_signing_key: "",
      apple_wallet_team_id: "",
      apple_wallet_wwdr_cert: "",
    });

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-apple-wallet#settings-apple-wallet",
      "Apple Wallet configuration cleared",
    )(response);
    expect(settings.appleWallet.hasConfig).toBe(false);
  });

  test("shows Apple Wallet section with masked values when configured", async () => {
    await configureAppleWallet();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie: await testCookie(),
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

/** Set all Apple Wallet env vars and return restore function */
const setWalletEnvVars = () =>
  setTestEnv({
    APPLE_WALLET_PASS_TYPE_ID: "pass.com.env.tickets",
    APPLE_WALLET_SIGNING_CERT: testCerts.signingCert,
    APPLE_WALLET_SIGNING_KEY: testCerts.signingKey,
    APPLE_WALLET_TEAM_ID: "ENVTEAM001",
    APPLE_WALLET_WWDR_CERT: testCerts.wwdrCert,
  });

describeWithEnv(
  "getHostAppleWalletConfig",
  {
    env: {
      APPLE_WALLET_PASS_TYPE_ID: undefined,
      APPLE_WALLET_SIGNING_CERT: undefined,
      APPLE_WALLET_SIGNING_KEY: undefined,
      APPLE_WALLET_TEAM_ID: undefined,
      APPLE_WALLET_WWDR_CERT: undefined,
    },
  },
  () => {
    test("returns null when no env vars are set", () => {
      expect(settings.appleWallet.hostConfig).toBeNull();
    });

    test("returns null when only some env vars are set", () => {
      Deno.env.set("APPLE_WALLET_PASS_TYPE_ID", "pass.com.test");
      Deno.env.set("APPLE_WALLET_TEAM_ID", "TEAM01");
      expect(settings.appleWallet.hostConfig).toBeNull();
    });

    test("returns config when all env vars are set", () => {
      setWalletEnvVars();
      const config = settings.appleWallet.hostConfig;
      expect(config).not.toBeNull();
      expect(config!.passTypeId).toBe("pass.com.env.tickets");
      expect(config!.teamId).toBe("ENVTEAM001");
      expect(config!.signingCert).toContain("BEGIN CERTIFICATE");
      expect(config!.signingKey).toContain("BEGIN RSA PRIVATE KEY");
      expect(config!.wwdrCert).toContain("BEGIN CERTIFICATE");
    });
  },
);

describeWithEnv(
  "Apple Wallet env var fallback",
  {
    db: true,
    env: {
      APPLE_WALLET_PASS_TYPE_ID: undefined,
      APPLE_WALLET_SIGNING_CERT: undefined,
      APPLE_WALLET_SIGNING_KEY: undefined,
      APPLE_WALLET_TEAM_ID: undefined,
      APPLE_WALLET_WWDR_CERT: undefined,
    },
  },
  () => {
    test("hasAppleWalletConfig returns true with env vars when DB not configured", () => {
      setWalletEnvVars();
      expect(settings.appleWallet.hasDbConfig).toBe(false);
      expect(settings.appleWallet.hasConfig).toBe(true);
    });

    test("getAppleWalletConfig falls back to env vars when DB not configured", () => {
      setWalletEnvVars();
      const config = settings.appleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.passTypeId).toBe("pass.com.env.tickets");
      expect(config!.teamId).toBe("ENVTEAM001");
    });

    test("getAppleWalletConfig prefers DB config over env vars", async () => {
      setWalletEnvVars();
      await configureAppleWallet();
      const config = settings.appleWallet.config;
      expect(config).not.toBeNull();
      expect(config!.passTypeId).toBe("pass.com.test.tickets");
      expect(config!.teamId).toBe("TESTTEAM01");
    });

    test("wallet route works with env var config", async () => {
      setWalletEnvVars();
      const { token } = await fetchValidPkpassForNewAttendee();

      const passJson = await parsePkpassJson(token);
      expect(passJson.passTypeIdentifier).toBe("pass.com.env.tickets");
      expect(passJson.teamIdentifier).toBe("ENVTEAM001");
    });

    test("ticket view shows wallet link with env var config", async () => {
      setWalletEnvVars();
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );
      const body = await fetchWalletTicketBody(token);
      expect(body).toContain("wallet-link");
      expect(body).toContain("Apple Wallet");
    });

    test("settings page shows host Apple Wallet label when env vars configured", async () => {
      setWalletEnvVars();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const body = await response.text();
      expect(body).toContain("Host env (pass.com.env.tickets)");
      expect(body).toContain("Currently using");
    });

    test("settings page shows overriding label when both DB and env configured", async () => {
      setWalletEnvVars();
      await configureAppleWallet();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const body = await response.text();
      expect(body).toContain("Host env (pass.com.env.tickets)");
      expect(body).toContain("Overriding");
    });
  },
);
