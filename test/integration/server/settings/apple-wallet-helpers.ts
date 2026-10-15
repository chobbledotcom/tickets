/**
 * Setup and read helpers for the Apple Wallet suites: certificate fixtures,
 * the settings form submission, and pkpass/ticket readers used by both the
 * route tests and the env-fallback tests.
 */
import { expect } from "@std/expect";
import { unzipSync } from "fflate";
import { handleRequest } from "#routes";
import { generateTestCerts } from "#test-utils/crypto.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { pemFor, rsaPrivateKey } from "#test-utils/der.ts";
import { withEnv } from "#test-utils/env.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

export const testCerts = generateTestCerts();
export const unusableRsaKey = pemFor("RSA PRIVATE KEY", rsaPrivateKey());

/** Submit Apple Wallet settings form with overrides applied to valid defaults */
export const submitWalletSettingsForm = async (
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
export const fetchPkpassResponse = (token: string) =>
  awaitTestRequest(`/wallet/${token}.pkpass`);

/** Fetch and parse pass.json from a pkpass response */
export const parsePkpassJson = async (
  token: string,
): Promise<Record<string, any>> => {
  const response = await fetchPkpassResponse(token);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(bytes);
  return JSON.parse(new TextDecoder().decode(files["pass.json"]!));
};

/** Fetch a ticket page and return the HTML body */
export const fetchWalletTicketBody = async (token: string): Promise<string> => {
  const response = await awaitTestRequest(`/t/${token}`);
  return response.text();
};

/** Create a test attendee, fetch pkpass, and assert 200 with correct content type */
export const fetchValidPkpassForNewAttendee = async () => {
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

/** Point the wallet config at the env-var source for one test. */
export const setWalletEnvVars = () =>
  withEnv({
    APPLE_WALLET_PASS_TYPE_ID: "pass.com.env.tickets",
    APPLE_WALLET_SIGNING_CERT: testCerts.signingCert,
    APPLE_WALLET_SIGNING_KEY: testCerts.signingKey,
    APPLE_WALLET_TEAM_ID: "ENVTEAM001",
    APPLE_WALLET_WWDR_CERT: testCerts.wwdrCert,
  });
