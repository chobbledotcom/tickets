import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAdminPassword,
  getCurrencyCode,
  getDbToken,
  getDbUrl,
  getPort,
  getStripeSecretKey,
  isPaymentsEnabled,
} from "#lib/config.ts";

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.CURRENCY_CODE;
    delete process.env.DB_URL;
    delete process.env.DB_TOKEN;
    delete process.env.PORT;
    delete process.env.ADMIN_PASSWORD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe("getStripeSecretKey", () => {
    test("returns null when not set", () => {
      expect(getStripeSecretKey()).toBeNull();
    });

    test("returns null when empty string", () => {
      process.env.STRIPE_SECRET_KEY = "";
      expect(getStripeSecretKey()).toBeNull();
    });

    test("returns null when whitespace only", () => {
      process.env.STRIPE_SECRET_KEY = "   ";
      expect(getStripeSecretKey()).toBeNull();
    });

    test("returns key when set", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      expect(getStripeSecretKey()).toBe("sk_test_123");
    });
  });

  describe("isPaymentsEnabled", () => {
    test("returns false when STRIPE_SECRET_KEY not set", () => {
      expect(isPaymentsEnabled()).toBe(false);
    });

    test("returns true when STRIPE_SECRET_KEY is set", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      expect(isPaymentsEnabled()).toBe(true);
    });
  });

  describe("getCurrencyCode", () => {
    test("returns GBP by default", () => {
      expect(getCurrencyCode()).toBe("GBP");
    });

    test("returns set value", () => {
      process.env.CURRENCY_CODE = "USD";
      expect(getCurrencyCode()).toBe("USD");
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

  describe("getAdminPassword", () => {
    test("returns undefined when not set", () => {
      expect(getAdminPassword()).toBeUndefined();
    });

    test("returns undefined when empty string", () => {
      process.env.ADMIN_PASSWORD = "";
      expect(getAdminPassword()).toBeUndefined();
    });

    test("returns undefined when whitespace only", () => {
      process.env.ADMIN_PASSWORD = "   ";
      expect(getAdminPassword()).toBeUndefined();
    });

    test("returns password when set", () => {
      process.env.ADMIN_PASSWORD = "mysecretpassword";
      expect(getAdminPassword()).toBe("mysecretpassword");
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
