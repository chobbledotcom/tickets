import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { execute, getDb } from "#shared/db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#shared/db/users.ts";
import {
  describeWithEnv,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  testWithSetting,
} from "#test-utils";

describeWithEnv("db > settings", { db: true }, () => {
  describe("basic CRUD", () => {
    test("getSetting returns null for missing key", () => {
      const value = settings.getCachedRaw("missing");
      expect(value).toBeNull();
    });

    test("setSetting and getSetting work together", async () => {
      await settings.setRaw("test_key", "test_value");
      await settings.loadKeys(["test_key"]);
      const value = settings.getCachedRaw("test_key");
      expect(value).toBe("test_value");
    });

    test("setSetting overwrites existing value", async () => {
      await settings.setRaw("key", "value1");
      await settings.setRaw("key", "value2");
      await settings.loadKeys(["key"]);
      const value = settings.getCachedRaw("key");
      expect(value).toBe("value2");
    });

    test("settings table writes invalidate the loaded settings cache", async () => {
      await settings.update.paymentProvider("stripe");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("stripe");

      await execute("UPDATE settings SET value = ? WHERE key = ?", [
        "square",
        CONFIG_KEYS.PAYMENT_PROVIDER,
      ]);
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);

      expect(settings.paymentProvider).toBe("square");
    });
  });

  describe("buildSnapshot via loadKeys", () => {
    test("loads valid payment provider from raw settings", async () => {
      await settings.setRaw("payment_provider", "stripe");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("stripe");
    });

    test("ignores invalid payment provider in raw settings", async () => {
      await settings.setRaw("payment_provider", "not-a-provider");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBeNull();
    });
  });

  describe("setup", () => {
    test("completeSetup sets all config values and generates key hierarchy", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      await settings.setup.complete("setupuser", "mypassword", "US");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      expect(await settings.setup.isComplete()).toBe(true);
      const user = await getUserByUsername("setupuser");
      expect(user).not.toBeNull();
      const hash = await verifyUserPassword(user!, "mypassword");
      expect(hash).toBeTruthy();
      expect(hash).toContain("pbkdf2:");
      expect(settings.currency).toBe("USD");

      expect(settings.publicKey).toBeTruthy();
      expect(user!.wrapped_data_key).toBeTruthy();
      expect(settings.wrappedPrivateKey).toBeTruthy();
    });

    test("completeSetup clears stale pre-setup settings cache and confirms setup", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      settings.setup.clearCache();
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.wrappedPrivateKey).toBe("");
      expect(settings.publicKey).toBe("");
      expect(await settings.setup.isComplete()).toBe(false);

      await settings.setup.complete("setupuser", "mypassword", "US");

      expect(await settings.setup.isComplete()).toBe(true);
      expect(settings.wrappedPrivateKey).toBe("");
      expect(settings.publicKey).toBe("");
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.wrappedPrivateKey).toBeTruthy();
      expect(settings.publicKey).toBeTruthy();
      expect(settings.country).toBe("US");
      expect(settings.currency).toBe("USD");
    });

    test("isComplete reloads cache when it has expired", async () => {
      settings.invalidateCache();
      const result = await settings.setup.isComplete();
      expect(result).toBe(true);
    });

    test("getCurrencyCodeFromDb returns GBP by default", () => {
      expect(settings.currency).toBe("GBP");
    });

    test("getCountryFromDb returns GB when no country is stored", async () => {
      await getDb().execute("DELETE FROM settings");
      settings.invalidateCache();
      expect(settings.country).toBe("GB");
    });
  });

  describe("stripe key", () => {
    test("hasStripeKey returns false when not set", () => {
      expect(settings.stripe.hasKey).toBe(false);
    });

    test("hasStripeKey returns true after setting key", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      expect(settings.stripe.hasKey).toBe(true);
    });

    test("getStripeSecretKeyFromDb returns empty string when not set", () => {
      expect(settings.stripe.secretKey).toBe("");
    });

    test("getStripeSecretKeyFromDb returns decrypted key after setting", async () => {
      await settings.update.stripe.secretKey("sk_test_secret_key");
      const key = settings.stripe.secretKey;
      expect(key).toBe("sk_test_secret_key");
    });

    test("updateStripeKey stores key encrypted", async () => {
      await settings.update.stripe.secretKey("sk_test_encrypted");
      await settings.loadKeys([CONFIG_KEYS.STRIPE_SECRET_KEY]);
      const rawValue = settings.getCachedRaw(CONFIG_KEYS.STRIPE_SECRET_KEY);
      expect(rawValue).toMatch(/^enc:1:/);
      expect(settings.stripe.secretKey).toBe("sk_test_encrypted");
    });

    test("updateStripeKey overwrites existing key", async () => {
      await settings.update.stripe.secretKey("sk_test_first");
      expect(settings.stripe.secretKey).toBe("sk_test_first");

      await settings.update.stripe.secretKey("sk_test_second");
      expect(settings.stripe.secretKey).toBe("sk_test_second");
    });

    test("getStripeKeyMode returns null when no key is set", () => {
      expect(settings.stripe.keyMode).toBeNull();
    });

    test("getStripeKeyMode returns test for sk_test_ key", async () => {
      await settings.update.stripe.secretKey("sk_test_abc123");
      expect(settings.stripe.keyMode).toBe("test");
    });

    test("getStripeKeyMode returns live for sk_live_ key", async () => {
      await settings.update.stripe.secretKey("sk_live_abc123");
      expect(settings.stripe.keyMode).toBe("live");
    });

    test("getStripeKeyMode returns null for unrecognised key prefix", async () => {
      await settings.update.stripe.secretKey("rk_invalid_abc123");
      expect(settings.stripe.keyMode).toBeNull();
    });
  });

  describe("additional settings", () => {
    test("clearPaymentProvider removes payment provider setting", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.getCachedRaw(CONFIG_KEYS.PAYMENT_PROVIDER)).toBe(
        "stripe",
      );

      await settings.update.clearPaymentProvider();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.getCachedRaw(CONFIG_KEYS.PAYMENT_PROVIDER)).toBeNull();
    });

    test("loadKeys sets theme to dark when stored value is dark", async () => {
      await settings.setRaw(CONFIG_KEYS.THEME, "dark");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.THEME]);
      expect(settings.theme).toBe("dark");
    });

    test("update.bookingFee with empty string resets to 0", async () => {
      await settings.update.bookingFee("500");
      expect(settings.bookingFee).toBe("500");
      await settings.update.bookingFee("");
      expect(settings.bookingFee).toBe("0");
    });

    test("update.stripe.secretKey with empty string sets empty string", async () => {
      await settings.update.stripe.secretKey("sk_test_abc");
      expect(settings.stripe.secretKey).toBe("sk_test_abc");
      await settings.update.stripe.secretKey("");
      expect(settings.stripe.secretKey).toBe("");
    });

    test("update.square.accessToken with empty string sets empty string", async () => {
      await settings.update.square.accessToken("token_123");
      expect(settings.square.accessToken).toBe("token_123");
      await settings.update.square.accessToken("");
      expect(settings.square.accessToken).toBe("");
    });

    test("update.square.webhookSignatureKey with empty string sets empty string", async () => {
      await settings.update.square.webhookSignatureKey("sig_key_123");
      expect(settings.square.webhookSignatureKey).toBe("sig_key_123");
      await settings.update.square.webhookSignatureKey("");
      expect(settings.square.webhookSignatureKey).toBe("");
    });

    test("update.square.locationId with empty string sets empty string", async () => {
      await settings.update.square.locationId("loc_123");
      expect(settings.square.locationId).toBe("loc_123");
      await settings.update.square.locationId("");
      expect(settings.square.locationId).toBe("");
    });

    test("updateUserPassword returns false when dataKey unwrap fails", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const passwordHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(passwordHash).toBeTruthy();

      const { settings: s } = await import("#shared/db/settings.ts");
      const result = await s.updateUserPassword(user!.id, {
        newPassword: "newpassword",
        oldKekVersion: user!.kek_version,
        oldPassword: TEST_ADMIN_PASSWORD,
        oldPasswordHash: passwordHash!,
        oldWrappedDataKey: "corrupted_wrapped_data_key",
      });
      expect(result).toBe(false);
    });
  });

  describe("timezone cache", () => {
    beforeEach(() => {
      settings.clearTestOverrides();
    });

    test("getTimezoneCached returns default when no cache exists", () => {
      settings.invalidateCache();
      expect(settings.timezone).toBe("Europe/London");
    });

    test("getTimezoneFromDb returns default when no country is stored", async () => {
      await getDb().execute({
        args: [CONFIG_KEYS.COUNTRY],
        sql: "DELETE FROM settings WHERE key = ?",
      });
      settings.invalidateCache();
      const value = settings.timezone;
      expect(value).toBe("Europe/London");
    });

    test("getTimezoneCached reads default from TTL cache when no country is stored", async () => {
      await getDb().execute({
        args: [CONFIG_KEYS.COUNTRY],
        sql: "DELETE FROM settings WHERE key = ?",
      });
      settings.invalidateCache();
      settings.getCachedRaw(CONFIG_KEYS.COUNTRY);
      expect(settings.timezone).toBe("Europe/London");
    });

    test("getTimezoneCached returns value after getTimezoneFromDb populates cache", async () => {
      await settings.update.country("US");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
      const value = settings.timezone;
      expect(value).toBe("America/New_York");
      expect(settings.timezone).toBe("America/New_York");
    });

    test("getTimezoneCached reads from TTL cache when permanent cache is empty", async () => {
      await settings.update.country("JP");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
      settings.getCachedRaw(CONFIG_KEYS.COUNTRY);
      expect(settings.timezone).toBe("Asia/Tokyo");
    });

    test("updateCountry updates the permanent cache immediately", async () => {
      await settings.update.country("NZ");
      expect(settings.timezone).toBe("Pacific/Auckland");
    });

    testWithSetting(
      "getTimezoneFromDb returns test override when set",
      { timezone: "America/Chicago" },
      () => {
        expect(settings.timezone).toBe("America/Chicago");
      },
    );

    test("getTimezoneFromDb returns permanent cache when set", () => {
      const value = settings.timezone;
      const cached = settings.timezone;
      expect(cached).toBe(value);
    });
  });
});
