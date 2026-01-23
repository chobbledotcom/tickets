import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getAllowedDomain,
  getCurrencyCode,
  getStripeSecretKey,
  isPaymentsEnabled,
  isSetupComplete,
} from "#lib/config.ts";
import { encrypt } from "#lib/crypto.ts";
import { completeSetup, setSetting } from "#lib/db/settings";
import { createTestDb, resetDb } from "#test-utils";

describe("config", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
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
      const encrypted = await encrypt("   ");
      await setSetting("stripe_key", encrypted);
      expect(await getStripeSecretKey()).toBeNull();
    });

    test("returns key when set in database", async () => {
      const encrypted = await encrypt("sk_test_123");
      await setSetting("stripe_key", encrypted);
      expect(await getStripeSecretKey()).toBe("sk_test_123");
    });
  });

  describe("isPaymentsEnabled", () => {
    test("returns false when stripe key not set", async () => {
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when stripe key is set", async () => {
      const encrypted = await encrypt("sk_test_123");
      await setSetting("stripe_key", encrypted);
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

  describe("getAllowedDomain", () => {
    test("returns set value from environment", () => {
      Deno.env.set("ALLOWED_DOMAIN", "example.com");
      expect(getAllowedDomain()).toBe("example.com");
    });

    test("returns localhost when set for testing", () => {
      Deno.env.set("ALLOWED_DOMAIN", "localhost");
      expect(getAllowedDomain()).toBe("localhost");
    });
  });
});
