import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, getDb } from "#db/client.ts";
import { setCacheState } from "#db/settings/cache.ts";
import { writeRawBatch } from "#db/settings/raw-writes.ts";
import {
  bumpSettingsVersion,
  CONFIG_KEYS,
  getCurrentSettingsVersion,
  settings,
} from "#db/settings.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > settings > cache", { db: true }, () => {
  describe("the cached state itself", () => {
    test("the version stamp reads -1 before any load", () => {
      setCacheState(null);
      expect(settings.version).toBe(-1);
    });

    test("registers its stats under the settings name", () => {
      expect(
        getAllCacheStats().some((stats) => stats.name === "settings"),
      ).toBe(true);
    });

    test("a stored empty string reads back as an empty string", async () => {
      await settings.setRaw("memo_empty", "");
      await settings.loadKeys(["memo_empty"]);
      expect(settings.getCachedRaw("memo_empty")).toBe("");
    });
  });

  describe("the shared version stamp", () => {
    test("writes several raw settings with one shared version bump", async () => {
      const before = await getCurrentSettingsVersion();

      await writeRawBatch([
        ["batch_one", "first"],
        ["batch_two", "second"],
      ]);

      expect(settings.getCachedRaw("batch_one")).toBe("first");
      expect(settings.getCachedRaw("batch_two")).toBe("second");
      expect(await getCurrentSettingsVersion()).toBe(before + 1);
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

    test("a change that bumps the settings version is picked up on the next load", async () => {
      // This process caches the current (unset) provider at the current version.
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBeNull();

      // Simulate another isolate switching to Stripe: it changes the value in
      // the DB and bumps the shared settings version, exactly as its write
      // would leave the database.
      await getDb().execute({
        args: [CONFIG_KEYS.PAYMENT_PROVIDER, "stripe"],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      });
      await bumpSettingsVersion();

      // The bumped version invalidates this process's cache on the next load.
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("stripe");
    });

    test("a raw DB change with no version bump is not picked up (cache stays authoritative)", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);
      expect(settings.paymentProvider).toBe("stripe");

      // Sneak a value change straight into the DB without bumping the version.
      await getDb().execute({
        args: ["square", CONFIG_KEYS.PAYMENT_PROVIDER],
        sql: "UPDATE settings SET value = ? WHERE key = ?",
      });
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);

      // Version unchanged → no reload → the cached value is served.
      expect(settings.paymentProvider).toBe("stripe");
    });

    test("a settings write through the client refreshes this request's version memo", async () => {
      await runWithRequestCache(async () => {
        await settings.setRaw("memo_version", "one");
        await settings.loadKeys(["memo_version"]);
        expect(settings.getCachedRaw("memo_version")).toBe("one");
        const stamped = settings.version;

        // Another isolate bumps the version without telling this request...
        await getDb().execute({
          args: ["memo_version", "two"],
          sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        });
        await bumpSettingsVersion();

        // ...then a settings write through the client invalidates this
        // request's caches, the version memo included.
        await execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          ["memo_version", "two"],
        );

        // The dropped memo re-probes, so the reload stamps the version that
        // moved while this request was holding an older one.
        await settings.loadKeys(["memo_version"]);
        expect(settings.version).toBe(stamped + 1);
        expect(settings.getCachedRaw("memo_version")).toBe("two");
      });
    });
  });

  describe("settings version probe", () => {
    test("treats a missing settings_version row as version 0", async () => {
      await getDb().execute({
        args: [CONFIG_KEYS.SETTINGS_VERSION],
        sql: "DELETE FROM settings WHERE key = ?",
      });
      expect(await getCurrentSettingsVersion()).toBe(0);
    });

    test("increments the version on each settings write", async () => {
      const before = await getCurrentSettingsVersion();
      await settings.update.theme("dark");
      expect(await getCurrentSettingsVersion()).toBe(before + 1);
    });
  });
});
