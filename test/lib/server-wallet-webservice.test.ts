import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import {
  updateAppleWalletPassTypeId,
  updateAppleWalletSigningCert,
  updateAppleWalletSigningKey,
  updateAppleWalletTeamId,
  updateAppleWalletWwdrCert,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  createTestAttendeeWithToken,
  createTestDbWithSetup,
  generateTestCerts,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

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

/** Make a request through the full handler pipeline */
const walletRequest = (
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
) =>
  handleRequest(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers: { host: "localhost", ...options.headers },
      ...(options.method === "POST"
        ? { body: "{}", headers: { host: "localhost", "content-type": "application/json", ...options.headers } }
        : {}),
    }),
  );

describe("Apple Wallet web service (/v1)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("POST /v1/devices/:deviceId/registrations/:passTypeId/:serialNumber", () => {
    test("returns 201 for device registration", async () => {
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test/serial-1",
        { method: "POST" },
      );
      expect(response.status).toBe(201);
    });
  });

  describe("DELETE /v1/devices/:deviceId/registrations/:passTypeId/:serialNumber", () => {
    test("returns 200 for device unregistration", async () => {
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test/serial-1",
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("GET /v1/devices/:deviceId/registrations/:passTypeId", () => {
    test("returns 401 without Authorization header", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test.tickets",
      );
      expect(response.status).toBe(401);
    });

    test("returns 204 when passTypeId does not match config", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.wrong",
        { headers: { Authorization: "ApplePass some-token" } },
      );
      expect(response.status).toBe(204);
    });

    test("returns 204 when wallet is not configured", async () => {
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test.tickets",
        { headers: { Authorization: "ApplePass some-token" } },
      );
      expect(response.status).toBe(204);
    });

    test("returns serial numbers and lastUpdated for valid request", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test.tickets",
        { headers: { Authorization: "ApplePass my-serial-token" } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.serialNumbers).toEqual(["my-serial-token"]);
      expect(body.lastUpdated).toBeDefined();
    });

    test("ignores passesUpdatedSince parameter", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/devices/abc123/registrations/pass.com.test.tickets?passesUpdatedSince=12345",
        { headers: { Authorization: "ApplePass my-serial-token" } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.serialNumbers).toEqual(["my-serial-token"]);
    });
  });

  describe("GET /v1/passes/:passTypeId/:serialNumber", () => {
    test("returns 404 when wallet is not configured", async () => {
      const response = await walletRequest(
        "/v1/passes/pass.com.test.tickets/some-token",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when passTypeId does not match", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/passes/pass.com.wrong/some-token",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for invalid serial number", async () => {
      await configureAppleWallet();
      const response = await walletRequest(
        "/v1/passes/pass.com.test.tickets/nonexistent-token",
      );
      expect(response.status).toBe(404);
    });

    test("returns valid pkpass for existing attendee token", async () => {
      await configureAppleWallet();
      const { token } = await createTestAttendeeWithToken(
        "Alice",
        "alice@test.com",
      );
      const response = await walletRequest(
        `/v1/passes/pass.com.test.tickets/${token}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "application/vnd.apple.pkpass",
      );

      const bytes = new Uint8Array(await response.arrayBuffer());
      const files = unzipSync(bytes);
      expect(files["pass.json"]).toBeDefined();

      const passJson = JSON.parse(
        new TextDecoder().decode(files["pass.json"]!),
      );
      expect(passJson.serialNumber).toBe(token);
      expect(passJson.passTypeIdentifier).toBe("pass.com.test.tickets");
    });
  });

  describe("POST /v1/log", () => {
    test("returns 200 for log submission", async () => {
      const response = await walletRequest("/v1/log", { method: "POST" });
      expect(response.status).toBe(200);
    });
  });
});
