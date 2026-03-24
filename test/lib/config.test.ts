import process from "node:process";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllowedDomain,
  getBookingFee,
  getEffectiveDomain,
  isPaymentsEnabled,
  loadEffectiveDomain,
  resetAllowedDomain,
  resetEffectiveDomain,
  setAllowedDomainForTest,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import { createTestDb, resetDb, setTestEnv, setupStripe } from "#test-utils";

describe("config", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  describe("isPaymentsEnabled", () => {
    test("returns false when no provider set", async () => {
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns false when provider set but no stripe key", async () => {
      await settings.update.paymentProvider("stripe");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns false when stripe key set but no provider", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when provider is stripe and key is set", async () => {
      await setupStripe("sk_test_123");
      expect(await isPaymentsEnabled()).toBe(true);
    });

    test("returns false when provider is square but no token", async () => {
      await settings.update.paymentProvider("square");
      expect(await isPaymentsEnabled()).toBe(false);
    });

    test("returns true when provider is square and token is set", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("EAAAl_test_123");
      expect(await isPaymentsEnabled()).toBe(true);
    });
  });

  describe("getAllowedDomain", () => {
    afterEach(() => resetAllowedDomain());

    test("returns set value via test override", () => {
      setAllowedDomainForTest("example.com");
      expect(getAllowedDomain()).toBe("example.com");
    });

    test("returns localhost when set for testing", () => {
      setAllowedDomainForTest("localhost");
      expect(getAllowedDomain()).toBe("localhost");
    });
  });

  describe("getEffectiveDomain", () => {
    afterEach(() => {
      resetAllowedDomain();
      resetEffectiveDomain();
    });

    test("returns ALLOWED_DOMAIN when no custom domain is set", async () => {
      setAllowedDomainForTest("mysite.bunny.run");
      const result = await loadEffectiveDomain();
      expect(result).toBe("mysite.bunny.run");
      expect(getEffectiveDomain()).toBe("mysite.bunny.run");
    });

    test("returns custom domain when set and validated in DB", async () => {
      setAllowedDomainForTest("mysite.bunny.run");
      await settings.update.customDomain("tickets.example.com");
      await settings.update.customDomainLastValidated();
      settings.invalidateCache();
      await settings.loadAll();
      const result = await loadEffectiveDomain();
      expect(result).toBe("tickets.example.com");
      expect(getEffectiveDomain()).toBe("tickets.example.com");
    });

    test("falls back to ALLOWED_DOMAIN when custom domain is set but not validated", async () => {
      setAllowedDomainForTest("mysite.bunny.run");
      await settings.update.customDomain("tickets.example.com");
      settings.invalidateCache();
      const result = await loadEffectiveDomain();
      expect(result).toBe("mysite.bunny.run");
      expect(getEffectiveDomain()).toBe("mysite.bunny.run");
    });

    test("falls back to ALLOWED_DOMAIN after custom domain is cleared", async () => {
      setAllowedDomainForTest("mysite.bunny.run");
      await settings.update.customDomain("tickets.example.com");
      await settings.update.customDomainLastValidated();
      settings.invalidateCache();
      await settings.loadAll();
      await loadEffectiveDomain();
      expect(getEffectiveDomain()).toBe("tickets.example.com");

      await settings.update.customDomain("");
      settings.invalidateCache();
      await settings.loadAll();
      await loadEffectiveDomain();
      expect(getEffectiveDomain()).toBe("mysite.bunny.run");
    });

    test("falls back to ALLOWED_DOMAIN before loadEffectiveDomain is called", () => {
      setAllowedDomainForTest("mysite.bunny.run");
      expect(getEffectiveDomain()).toBe("mysite.bunny.run");
    });

    test("setEffectiveDomainForTest overrides the cached value", () => {
      setAllowedDomainForTest("mysite.bunny.run");
      setEffectiveDomainForTest("custom.example.com");
      expect(getEffectiveDomain()).toBe("custom.example.com");
    });

    test("resetEffectiveDomain clears the cached value", async () => {
      setAllowedDomainForTest("mysite.bunny.run");
      await settings.update.customDomain("tickets.example.com");
      await settings.update.customDomainLastValidated();
      settings.invalidateCache();
      await settings.loadAll();
      await loadEffectiveDomain();
      expect(getEffectiveDomain()).toBe("tickets.example.com");

      resetEffectiveDomain();
      expect(getEffectiveDomain()).toBe("mysite.bunny.run");
    });
  });

  describe("isPaymentsEnabled - non-stripe provider", () => {
    test("returns false when provider is set to unknown value", async () => {
      await settings.setRaw("payment_provider", "paypal");
      await settings.update.stripe.secretKey("sk_test_123");
      // Unknown provider doesn't match "stripe" or "square", so isPaymentsEnabled returns false
      expect(await isPaymentsEnabled()).toBe(false);
    });
  });

  describe("getBookingFee", () => {
    test("returns 0 when not set", async () => {
      expect(await getBookingFee()).toBe(0);
    });

    test("returns parsed value when set", async () => {
      await settings.update.bookingFee("1.5");
      expect(await getBookingFee()).toBe(1.5);
    });

    test("returns 0 for unparseable value", async () => {
      await settings.update.bookingFee("abc");
      expect(await getBookingFee()).toBe(0);
    });
  });
});

describe("env", () => {
  test("getEnv returns undefined when variable is not set anywhere", () => {
    const uniqueKey = "TOTALLY_NONEXISTENT_VAR_XYZ_123";
    // Ensure it's not in process.env
    delete process.env[uniqueKey];
    const restore = setTestEnv({ [uniqueKey]: undefined });

    const result = getEnv(uniqueKey);
    expect(result).toBeUndefined();
    restore();
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
    const restore = setTestEnv({ [key]: "from_deno" });
    const result = getEnv(key);
    expect(result).toBe("from_deno");
    restore();
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
    await settings.setRaw("payment_provider", "unknown_provider");
    const provider = await getActivePaymentProvider();
    expect(provider).toBeNull();
  });

  test("getActivePaymentProvider returns stripe provider when configured", async () => {
    await settings.update.paymentProvider("stripe");
    const provider = await getActivePaymentProvider();
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("stripe");
  });

  test("getActivePaymentProvider returns square provider when configured", async () => {
    await settings.update.paymentProvider("square");
    const provider = await getActivePaymentProvider();
    expect(provider).not.toBeNull();
    expect(provider?.type).toBe("square");
  });

  test("settings.timezone returns default timezone when cache is empty", () => {
    expect(settings.timezone).toBe("Europe/London");
  });
});
