import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getAllowedDomain,
  getCurrencyCode,
  getPaymentProvider,
  getStripePublishableKey,
  getStripeSecretKey,
  isPaymentsEnabled,
  isSetupComplete,
} from "#lib/config.ts";
import { completeSetup, setPaymentProvider, setSetting, updateStripeKey } from "#lib/db/settings.ts";
import { createTestDb, resetDb } from "#test-utils";
import process from "node:process";

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await createTestDb();
    // Clear Stripe env vars for clean tests
    delete process.env.STRIPE_PUBLISHABLE_KEY;
  });

  afterEach(() => {
    resetDb();
    // Restore original env
    process.env.STRIPE_PUBLISHABLE_KEY = originalEnv.STRIPE_PUBLISHABLE_KEY;
  });

  describe("getPaymentProvider", () => {
    test("returns null when not set", async () => {
      expect(await getPaymentProvider()).toBeNull();
    });

    test("returns stripe when set to stripe", async () => {
      await setPaymentProvider("stripe");
      expect(await getPaymentProvider()).toBe("stripe");
    });

    test("returns null for unknown provider", async () => {
      await setSetting("payment_provider", "unknown");
      expect(await getPaymentProvider()).toBeNull();
    });
  });

  describe("getStripeSecretKey", () => {
    test("returns null when not set in database", async () => {
      expect(await getStripeSecretKey()).toBeNull();
    });

    test("returns key when set in database", async () => {
      await updateStripeKey("sk_test_123");
      expect(await getStripeSecretKey()).toBe("sk_test_123");
    });
  });

  describe("getStripePublishableKey", () => {
    test("returns null when not set in environment", () => {
      expect(getStripePublishableKey()).toBeNull();
    });

    test("returns key when set in environment", () => {
      process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_123";
      expect(getStripePublishableKey()).toBe("pk_test_123");
    });
  });

  describe("isPaymentsEnabled", () => {
    test("returns false when no provider set", async () => {
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns false when provider set but no stripe key", async () => {
      await setPaymentProvider("stripe");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns false when stripe key set but no provider", async () => {
      await updateStripeKey("sk_test_123");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when provider is stripe and key is set", async () => {
      await setPaymentProvider("stripe");
      await updateStripeKey("sk_test_123");
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
      await completeSetup("password123", "GBP");
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
