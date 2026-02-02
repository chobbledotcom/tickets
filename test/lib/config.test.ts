import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getAllowedDomain,
  getCurrencyCode,
  getPaymentProvider,
  getSquareAccessToken,
  getSquareLocationId,
  getSquareWebhookSignatureKey,
  getStripePublishableKey,
  getStripeSecretKey,
  isPaymentsEnabled,
  isSetupComplete,
} from "#lib/config.ts";
import { getEnv } from "#lib/env.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import {
  completeSetup,
  setPaymentProvider,
  setSetting,
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
} from "#lib/db/settings.ts";
import { createTestDb, resetDb, setupStripe } from "#test-utils";
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

    test("returns square when set to square", async () => {
      await setPaymentProvider("square");
      expect(await getPaymentProvider()).toBe("square");
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
      await setupStripe("sk_test_123");
      expect(await isPaymentsEnabled()).toBe(true);
    });

    test("returns false when provider is square but no token", async () => {
      await setPaymentProvider("square");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when provider is square and token is set", async () => {
      await setPaymentProvider("square");
      await updateSquareAccessToken("EAAAl_test_123");
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
      await completeSetup("testadmin", "password123", "GBP");
      expect(await isSetupComplete()).toBe(true);
    });
  });

  describe("getSquareAccessToken", () => {
    test("returns null when not set in database", async () => {
      expect(await getSquareAccessToken()).toBeNull();
    });

    test("returns token when set in database", async () => {
      await updateSquareAccessToken("EAAAl_test_123");
      expect(await getSquareAccessToken()).toBe("EAAAl_test_123");
    });
  });

  describe("getSquareWebhookSignatureKey", () => {
    test("returns null when not set in database", async () => {
      expect(await getSquareWebhookSignatureKey()).toBeNull();
    });

    test("returns key when set in database", async () => {
      await updateSquareWebhookSignatureKey("sig_key_test");
      expect(await getSquareWebhookSignatureKey()).toBe("sig_key_test");
    });
  });

  describe("getSquareLocationId", () => {
    test("returns null when not set in database", async () => {
      expect(await getSquareLocationId()).toBeNull();
    });

    test("returns location ID when set in database", async () => {
      await updateSquareLocationId("L_test_123");
      expect(await getSquareLocationId()).toBe("L_test_123");
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

  describe("isPaymentsEnabled - non-stripe provider", () => {
    test("returns false when provider is set to unknown value", async () => {
      // Set provider to a non-stripe value that getPaymentProvider will return null for
      await setSetting("payment_provider", "paypal");
      await updateStripeKey("sk_test_123");
      // getPaymentProvider returns null for unknown providers, so isPaymentsEnabled returns false
      expect(await isPaymentsEnabled()).toBe(false);
    });
  });

  describe("getStripePublishableKey - edge cases", () => {
    test("returns null when key is whitespace only", () => {
      process.env.STRIPE_PUBLISHABLE_KEY = "   ";
      expect(getStripePublishableKey()).toBeNull();
    });
  });

});

describe("env", () => {
  test("getEnv returns undefined when variable is not set anywhere", () => {
    const uniqueKey = "TOTALLY_NONEXISTENT_VAR_XYZ_123";
    // Ensure it's not in process.env
    delete process.env[uniqueKey];
    // Ensure it's not in Deno.env
    try { Deno.env.delete(uniqueKey); } catch { /* may not exist */ }

    const result = getEnv(uniqueKey);
    expect(result).toBeUndefined();
  });

  test("getEnv reads from process.env when available", () => {
    process.env.TEST_ENV_VAR_CONFIG = "from_process";
    const result = getEnv("TEST_ENV_VAR_CONFIG");
    expect(result).toBe("from_process");
    delete process.env.TEST_ENV_VAR_CONFIG;
  });

  test("getEnv falls back to Deno.env when not in process.env", () => {
    const key = "TEST_DENO_ONLY_VAR";
    delete process.env[key];
    Deno.env.set(key, "from_deno");
    const result = getEnv(key);
    expect(result).toBe("from_deno");
    Deno.env.delete(key);
  });
});

describe("payments", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("getActivePaymentProvider returns null when no provider configured", async () => {
    const provider = await getActivePaymentProvider();
    expect(provider).toBeNull();
  });

  test("getActivePaymentProvider returns null for unknown provider type", async () => {
    // Set a non-stripe provider type directly
    await setSetting("payment_provider", "unknown_provider");
    const provider = await getActivePaymentProvider();
    expect(provider).toBeNull();
  });

  test("getActivePaymentProvider returns stripe provider when configured", async () => {
    await setPaymentProvider("stripe");
    const provider = await getActivePaymentProvider();
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("stripe");
  });

  test("getActivePaymentProvider returns square provider when configured", async () => {
    await setPaymentProvider("square");
    const provider = await getActivePaymentProvider();
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("square");
  });

});
