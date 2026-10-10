/** Direct tests for db/settings/apply.ts — the key registry and the fields
 *  the country setting derives. */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedCountry, testWithSetting } from "#test-utils/settings.ts";

describeWithEnv("db > settings > apply", { db: true }, () => {
  describe("the settings key registry", () => {
    test("excludes retired maintenance timestamps from settings snapshots", () => {
      expect(
        ALL_SETTINGS_KEYS.filter(
          (key) =>
            key.startsWith("last_pruned_") ||
            key === "last_activity_log_backfill" ||
            key === "activity_log_backfill_done",
        ),
      ).toEqual([]);
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
      await seedCountry("US");
      await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
      const value = settings.timezone;
      expect(value).toBe("America/New_York");
      expect(settings.timezone).toBe("America/New_York");
    });

    test("getTimezoneCached reads from TTL cache when permanent cache is empty", async () => {
      await seedCountry("JP");
      await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
      settings.getCachedRaw(CONFIG_KEYS.COUNTRY);
      expect(settings.timezone).toBe("Asia/Tokyo");
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
