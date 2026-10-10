import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#crypto/encryption.ts";
import { execute, getDb } from "#db/client.ts";
import { bumpSettingsVersion, CONFIG_KEYS, settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { statementSql } from "#test-utils/record-queries.ts";

describeWithEnv("db > settings > load", { db: true }, () => {
  test("reloads setting values from primary after a write", async () => {
    await settings.update.paymentProvider("stripe");
    const staleReplicaResult = await getDb().execute({
      args: [CONFIG_KEYS.PAYMENT_PROVIDER],
      sql: "SELECT key, value FROM settings WHERE key = ?",
    });
    const staleVersionResult = await getDb().execute({
      args: [CONFIG_KEYS.SETTINGS_VERSION],
      sql: "SELECT value FROM settings WHERE key = ?",
    });

    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      "square",
      CONFIG_KEYS.PAYMENT_PROVIDER,
    ]);
    await bumpSettingsVersion();

    using _env = withEnv({ DB_URL: "libsql://replica.test" });
    const replicaRead = stub(getDb(), "execute", (statement) =>
      Promise.resolve(
        statementSql(statement).startsWith("SELECT value FROM settings")
          ? staleVersionResult
          : staleReplicaResult,
      ),
    );
    try {
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("square");
    } finally {
      replicaRead.restore();
    }
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
      // isSetupComplete calls loadKeys, which serves the already-resolved key
      // from the cache while the settings version is unchanged (no full reload).
      // Setup must be incomplete so the permanent-cache short-circuit doesn't
      // fire first.
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
});
