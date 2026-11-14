import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { getDb } from "#db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  bumpSettingsVersion,
  CONFIG_KEYS,
  settings,
} from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The bodies the page-setting cases store. A page setting keeps whatever text
 *  it is given, so one set of bodies covers all four. */
const SET_VALUE = "My Site";
const OLD_VALUE = "Old Title";
const NEW_VALUE = "New Title";
const CLEARED_FROM = "Title";

/** The page settings the cache serves, as `settings` keys. */
type PageKey = "contactPageText" | "homepageText" | "terms" | "websiteTitle";

/** One page setting: its describe title, the getter/updater key, the title of
 *  its single-update case (the terms text is stored unencrypted, so it does not
 *  claim decryption), and whether it can be cleared. */
type PageSetting = readonly [
  describeTitle: string,
  key: PageKey,
  writeTitle: string,
  clears: boolean,
];

const pageSettings: readonly PageSetting[] = [
  [
    "getWebsiteTitleFromDb",
    "websiteTitle",
    "returns decrypted value after update",
    true,
  ],
  [
    "getHomepageTextFromDb",
    "homepageText",
    "returns decrypted value after update",
    false,
  ],
  [
    "getContactPageTextFromDb",
    "contactPageText",
    "returns decrypted value after update",
    false,
  ],
  ["getTermsAndConditionsFromDb", "terms", "returns value after update", true],
];

/** Register the cases every page setting shares: empty before any write, the
 *  written value, and the value re-read after an update invalidates the cache.
 *  `clears` adds the case for a setting that must read empty again after an
 *  empty write. */
const registerPageCases = (
  read: () => string,
  write: (value: string) => Promise<void>,
  writeTitle: string,
  clears: boolean,
): void => {
  test("returns empty string when not set", () => {
    expect(read()).toBe("");
  });

  test(writeTitle, async () => {
    await write(SET_VALUE);
    expect(read()).toBe(SET_VALUE);
  });

  test("returns updated value after update invalidates cache", async () => {
    await write(OLD_VALUE);
    expect(read()).toBe(OLD_VALUE);
    await write(NEW_VALUE);
    expect(read()).toBe(NEW_VALUE);
  });

  if (clears) {
    test("returns empty string after clearing with empty string", async () => {
      await write(CLEARED_FROM);
      expect(read()).toBe(CLEARED_FROM);
      await write("");
      expect(read()).toBe("");
    });
  }
};

describeWithEnv("page content cache", { db: true }, () => {
  for (const [describeTitle, key, writeTitle, clears] of pageSettings) {
    describe(describeTitle, () => {
      registerPageCases(
        () => settings[key],
        settings.update[key],
        writeTitle,
        clears,
      );
    });
  }

  describe("version-gated freshness", () => {
    /**
     * Seed the cache and stamp it at the current version, then sneak a raw DB
     * change for the same key that does NOT bump the settings version — as far
     * as the cache's version stamp is concerned, nothing changed.
     */
    const seedAndBypassCache = async (newValue: string): Promise<void> => {
      await settings.update.terms("Original");
      await settings.loadKeys(ALL_SETTINGS_KEYS); // stamp cache at current version
      expect(settings.terms).toBe("Original");

      await getDb().execute(
        sql`UPDATE settings SET value = ${newValue} WHERE key = ${CONFIG_KEYS.TERMS_AND_CONDITIONS}`,
      );
    };

    test("serves the cached value while the settings version is unchanged", async () => {
      await seedAndBypassCache("Changed");

      // No version bump accompanied the raw write, so loadKeys skips the reload.
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.terms).toBe("Original");
    });

    test("re-fetches from the DB once the settings version is bumped", async () => {
      await seedAndBypassCache("Changed");

      // Mimic another isolate's write: it would have bumped the shared version.
      await bumpSettingsVersion();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.terms).toBe("Changed");
    });

    test("serves the cached decrypted value while the version is unchanged", async () => {
      await settings.update.websiteTitle("Original Title");
      await settings.loadKeys(ALL_SETTINGS_KEYS); // stamp cache at current version
      expect(settings.websiteTitle).toBe("Original Title");

      // Write a different encrypted value directly to the DB, no version bump.
      const newEncrypted = await encrypt("Changed Title");
      await getDb().execute(
        sql`UPDATE settings SET value = ${newEncrypted} WHERE key = ${CONFIG_KEYS.WEBSITE_TITLE}`,
      );

      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.websiteTitle).toBe("Original Title");
    });
  });

  describe("invalidatePageCache", () => {
    /** Assert all four page getters return the seeded values */
    const expectAllPages = () => {
      expect(settings.websiteTitle).toBe("Title");
      expect(settings.homepageText).toBe("Homepage");
      expect(settings.contactPageText).toBe("Contact");
      expect(settings.terms).toBe("Terms");
    };

    test("clears all cached page entries", async () => {
      await settings.update.websiteTitle("Title");
      await settings.update.homepageText("Homepage");
      await settings.update.contactPageText("Contact");
      await settings.update.terms("Terms");

      // Populate all caches
      await expectAllPages();

      // Clear all and reload
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      // Values should still be correct (reloaded from DB)
      expectAllPages();
    });
  });

  describe("invalidateSettingsCache clears page cache", () => {
    test("page cache is cleared when settings cache is invalidated", async () => {
      await settings.update.websiteTitle("Title");
      // Populate page cache
      expect(settings.websiteTitle).toBe("Title");

      // invalidateCache clears the snapshot; loadAll re-populates
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      // Returns correct value after reload
      expect(settings.websiteTitle).toBe("Title");
    });
  });

  describe("cache stats after invalidation", () => {
    test("settings cache reports 0 entries after invalidation", async () => {
      const { getAllCacheStats } = await import("#shared/cache-registry.ts");

      // Load settings to populate cache
      const { settings: s } = await import("#db/settings.ts");
      await s.loadKeys(ALL_SETTINGS_KEYS);

      const before = getAllCacheStats().find((s) => s.name === "settings");
      expect(before!.entries).toBeGreaterThan(0);

      settings.invalidateCache();

      const after = getAllCacheStats().find((s) => s.name === "settings");
      expect(after!.entries).toBe(0);
    });
  });

  describe("null value caching", () => {
    test("serves cached null when value is added to DB within TTL", async () => {
      // First read populates page cache with ""
      expect(settings.terms).toBe("");

      // Write directly to DB, bypassing page cache invalidation
      await getDb().execute(
        sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${CONFIG_KEYS.TERMS_AND_CONDITIONS}, ${"Surprise"})`,
      );

      // Page cache still holds ""
      expect(settings.terms).toBe("");
    });
  });
});
