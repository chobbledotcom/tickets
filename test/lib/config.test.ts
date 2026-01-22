import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getCurrencyCode,
  getDbToken,
  getDbUrl,
  getPort,
  getStripeSecretKey,
  isPaymentsEnabled,
  isSetupComplete,
} from "#lib/config.ts";
import { completeSetup, setSetting } from "#lib/db.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Clear relevant env vars before each test
    delete process.env.DB_URL;
    delete process.env.DB_TOKEN;
    delete process.env.PORT;
    // Create in-memory db for testing
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe("getStripeSecretKey", () => {
    test("returns null when not set in database", async () => {
      expect(await getStripeSecretKey()).toBeNull();
    });

    test("returns null when empty string in database", async () => {
      await setSetting("stripe_key", "");
      expect(await getStripeSecretKey()).toBeNull();
    });

    test("returns null when whitespace only in database", async () => {
      await setSetting("stripe_key", "   ");
      expect(await getStripeSecretKey()).toBeNull();
    });

    test("returns key when set in database", async () => {
      await setSetting("stripe_key", "sk_test_123");
      expect(await getStripeSecretKey()).toBe("sk_test_123");
    });
  });

  describe("isPaymentsEnabled", () => {
    test("returns false when stripe key not set", async () => {
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when stripe key is set", async () => {
      await setSetting("stripe_key", "sk_test_123");
      expect(await isPaymentsEnabled()).toBe(true);
    });
  });

  describe("getCurrencyCode", () => {
    test("returns GBP by default", async () => {
      expect(await getCurrencyCode()).toBe("GBP");
    });

    test("returns set value from database", async () => {
      await setSetting("currency_code", "USD");
      expect(await getCurrencyCode()).toBe("USD");
    });
  });

  describe("isSetupComplete", () => {
    test("returns false when setup not complete", async () => {
      expect(await isSetupComplete()).toBe(false);
    });

    test("returns true when setup is complete", async () => {
      await completeSetup("password123", null, "GBP");
      expect(await isSetupComplete()).toBe(true);
    });
  });

  describe("getDbUrl", () => {
    test("returns undefined when not set", () => {
      expect(getDbUrl()).toBeUndefined();
    });

    test("returns set value", () => {
      process.env.DB_URL = "libsql://test.turso.io";
      expect(getDbUrl()).toBe("libsql://test.turso.io");
    });
  });

  describe("getDbToken", () => {
    test("returns undefined when not set", () => {
      expect(getDbToken()).toBeUndefined();
    });

    test("returns set value", () => {
      process.env.DB_TOKEN = "token123";
      expect(getDbToken()).toBe("token123");
    });
  });

  describe("getPort", () => {
    test("returns 3000 by default", () => {
      expect(getPort()).toBe(3000);
    });

    test("returns set value as number", () => {
      process.env.PORT = "8080";
      expect(getPort()).toBe(8080);
    });
  });
});
