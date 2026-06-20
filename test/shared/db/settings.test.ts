import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb } from "#shared/db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#shared/db/users.ts";
import { DEFAULT_ORPHAN_RETENTION } from "#shared/orphan-retention.ts";
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

  describe("loadKeys (on-demand)", () => {
    test("resolves only the requested key into the snapshot", async () => {
      await settings.setRaw(CONFIG_KEYS.THEME, "dark");
      await settings.setRaw(CONFIG_KEYS.BUSINESS_EMAIL, await encrypt("a@b.c"));
      settings.invalidateCache();

      await settings.loadKeys([CONFIG_KEYS.THEME]);

      expect(settings.theme).toBe("dark");
      // An undeclared key stays at its default — it was never fetched.
      expect(settings.businessEmail).toBe("");
    });

    test("decrypts an encrypted key it is asked to load", async () => {
      await settings.setRaw(
        CONFIG_KEYS.BUSINESS_EMAIL,
        await encrypt("owner@example.com"),
      );
      settings.invalidateCache();

      await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);

      expect(settings.businessEmail).toBe("owner@example.com");
    });

    test("retries a key when snapshot application fails", async () => {
      await getDb().execute({
        args: [CONFIG_KEYS.BUSINESS_EMAIL, "not encrypted"],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      });
      settings.invalidateCache();

      await expect(
        settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]),
      ).rejects.toThrow("Invalid encrypted data format");

      await getDb().execute({
        args: [CONFIG_KEYS.BUSINESS_EMAIL, await encrypt("fixed@example.com")],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      });
      await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);

      expect(settings.businessEmail).toBe("fixed@example.com");
    });

    test("applies country-derived fields", async () => {
      await settings.setRaw(CONFIG_KEYS.COUNTRY, "US");
      settings.invalidateCache();

      await settings.loadKeys([CONFIG_KEYS.COUNTRY]);

      expect(settings.country).toBe("US");
      expect(settings.currency).toBe("USD");
    });

    test("re-reads an already-loaded key without re-querying", async () => {
      // isSetupComplete uses isKeyLoaded to skip loadKeys when the key is
      // already resolved in a fresh partial cache (no full load). Setup must
      // be incomplete so the permanent-cache short-circuit doesn't fire first.
      settings.setup.clearCache();
      await getDb().execute({
        args: [CONFIG_KEYS.SETUP_COMPLETE],
        sql: "DELETE FROM settings WHERE key = ?",
      });
      settings.invalidateCache();

      // First call: not loaded → loadKeys fetches just setup_complete.
      expect(await settings.setup.isComplete()).toBe(false);
      // Second call: fresh partial cache already holds the key → isKeyLoaded
      // returns true via the loaded-set branch, so no second query runs.
      expect(await settings.setup.isComplete()).toBe(false);
    });

    test("is a no-op when the requested key is already loaded", async () => {
      await settings.setRaw(CONFIG_KEYS.THEME, "dark");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.THEME]);

      // Mutate the DB after the load; loadKeys must not re-fetch a key
      // the fresh cache already holds.
      await getDb().execute({
        args: ["light", CONFIG_KEYS.THEME],
        sql: "UPDATE settings SET value = ? WHERE key = ?",
      });
      await settings.loadKeys([CONFIG_KEYS.THEME]);

      expect(settings.theme).toBe("dark");
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

  // ---------------------------------------------------------------------------
  // Superuser choice settings DB extension
  // ---------------------------------------------------------------------------

  describe("superuser_choice schema and key registration", () => {
    test("CONFIG_KEYS.SUPERUSER_CHOICE exists with value 'superuser_choice'", () => {
      expect(CONFIG_KEYS.SUPERUSER_CHOICE).toBe("superuser_choice");
    });

    test("superuser_choice is listed in PLAINTEXT_KEYS", async () => {
      // Write it and check it comes back without encryption prefix
      await settings.update.superuserChoice("self-managed");
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      const raw = settings.getCachedRaw("superuser_choice");
      expect(raw).toBe("self-managed");
    });

    test("superuser_choice is NOT in ENCRYPTED_KEYS", async () => {
      await settings.update.superuserChoice("enabled");
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      const raw = settings.getCachedRaw("superuser_choice");
      expect(raw).not.toMatch(/^enc:1:/);
    });
  });

  describe("superuserChoice getter behavior", () => {
    test("settings.superuserChoice returns '' from a fresh database", () => {
      settings.invalidateCache();
      expect(settings.superuserChoice).toBe("");
    });

    test("settings.superuserChoice returns 'self-managed' after writing", async () => {
      await settings.update.superuserChoice("self-managed");
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("settings.superuserChoice returns 'enabled' after writing", async () => {
      await settings.update.superuserChoice("enabled");
      expect(settings.superuserChoice).toBe("enabled");
    });

    test("settings.superuserChoice getter is consistent across multiple reads", async () => {
      await settings.update.superuserChoice("self-managed");
      const read1 = settings.superuserChoice;
      const read2 = settings.superuserChoice;
      expect(read1).toBe("self-managed");
      expect(read2).toBe("self-managed");
    });

    test("settings.superuserChoice returns '' when stored value is invalid", async () => {
      await settings.setRaw(CONFIG_KEYS.SUPERUSER_CHOICE, "invalid");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);

      expect(settings.superuserChoice).toBe("");
    });
  });

  describe("superuserChoice writer behavior", () => {
    test("settings.update.superuserChoice persists across a round-trip", async () => {
      await settings.update.superuserChoice("enabled");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      expect(settings.superuserChoice).toBe("enabled");
    });

    test("writing the same value twice is idempotent", async () => {
      await settings.update.superuserChoice("self-managed");
      await settings.update.superuserChoice("self-managed");
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("writing '' (empty string) resets the choice", async () => {
      await settings.update.superuserChoice("enabled");
      await settings.update.superuserChoice("");
      expect(settings.superuserChoice).toBe("");
    });
  });

  describe("superuserChoice test override support", () => {
    test("setForTest can override superuser_choice to 'self-managed'", () => {
      settings.setForTest({ superuser_choice: "self-managed" });
      expect(settings.superuserChoice).toBe("self-managed");
      settings.clearTestOverride("superuser_choice");
    });

    test("setForTest can override superuser_choice to 'enabled'", () => {
      settings.setForTest({ superuser_choice: "enabled" });
      expect(settings.superuserChoice).toBe("enabled");
      settings.clearTestOverride("superuser_choice");
    });

    test("setForTest override for superuser_choice does not interfere with other settings", () => {
      settings.setForTest({ country: "US", superuser_choice: "self-managed" });
      expect(settings.superuserChoice).toBe("self-managed");
      expect(settings.country).toBe("US");
      settings.clearTestOverride("superuser_choice", "country");
    });

    test("setForTest with empty superuser_choice resets it", async () => {
      await settings.update.superuserChoice("enabled");
      settings.setForTest({ superuser_choice: "" });
      expect(settings.superuserChoice).toBe("");
      settings.clearTestOverride("superuser_choice");
    });
  });

  describe("orphan-purge settings", () => {
    const loadOrphanKeys = () =>
      settings.loadKeys([
        CONFIG_KEYS.AUTO_PURGE_ORPHANS,
        CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
      ]);

    test("autoPurgeOrphans defaults to on for a fresh database", async () => {
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(true);
    });

    test("autoPurgeOrphans reads an explicit 'false'", async () => {
      await settings.setRaw(CONFIG_KEYS.AUTO_PURGE_ORPHANS, "false");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(false);
    });

    test("autoPurgeOrphans reads an explicit 'true'", async () => {
      await settings.setRaw(CONFIG_KEYS.AUTO_PURGE_ORPHANS, "true");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(true);
    });

    test("update.autoPurgeOrphans persists across a round-trip", async () => {
      await settings.update.autoPurgeOrphans(false);
      expect(settings.autoPurgeOrphans).toBe(false);
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(false);
    });

    test("orphanPurgeRetention defaults to 6 months (182 days)", async () => {
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe(DEFAULT_ORPHAN_RETENTION);
    });

    test("orphanPurgeRetention keeps a valid stored age", async () => {
      await settings.setRaw(CONFIG_KEYS.ORPHAN_PURGE_RETENTION, "365");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe("365");
    });

    test("orphanPurgeRetention coerces an invalid stored age to the default", async () => {
      await settings.setRaw(CONFIG_KEYS.ORPHAN_PURGE_RETENTION, "not-an-age");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe(DEFAULT_ORPHAN_RETENTION);
    });

    test("update.orphanPurgeRetention persists across a round-trip", async () => {
      await settings.update.orphanPurgeRetention("730");
      expect(settings.orphanPurgeRetention).toBe("730");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe("730");
    });
  });
});
