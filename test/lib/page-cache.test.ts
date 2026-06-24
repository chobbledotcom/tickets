import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb } from "#shared/db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  bumpSettingsVersion,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("page content cache", { db: true }, () => {
  describe("getWebsiteTitleFromDb", () => {
    test("returns empty string when not set", () => {
      expect(settings.websiteTitle).toBe("");
    });

    test("returns decrypted value after update", async () => {
      await settings.update.websiteTitle("My Site");
      expect(settings.websiteTitle).toBe("My Site");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.update.websiteTitle("Old Title");
      expect(settings.websiteTitle).toBe("Old Title");
      await settings.update.websiteTitle("New Title");
      expect(settings.websiteTitle).toBe("New Title");
    });

    test("returns empty string after clearing with empty string", async () => {
      await settings.update.websiteTitle("Title");
      expect(settings.websiteTitle).toBe("Title");
      await settings.update.websiteTitle("");
      expect(settings.websiteTitle).toBe("");
    });
  });

  describe("getHomepageTextFromDb", () => {
    test("returns empty string when not set", () => {
      expect(settings.homepageText).toBe("");
    });

    test("returns decrypted value after update", async () => {
      await settings.update.homepageText("Welcome!");
      expect(settings.homepageText).toBe("Welcome!");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.update.homepageText("Old text");
      expect(settings.homepageText).toBe("Old text");
      await settings.update.homepageText("New text");
      expect(settings.homepageText).toBe("New text");
    });
  });

  describe("getContactPageTextFromDb", () => {
    test("returns empty string when not set", () => {
      expect(settings.contactPageText).toBe("");
    });

    test("returns decrypted value after update", async () => {
      await settings.update.contactPageText("Contact us here");
      expect(settings.contactPageText).toBe("Contact us here");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.update.contactPageText("Old contact");
      expect(settings.contactPageText).toBe("Old contact");
      await settings.update.contactPageText("New contact");
      expect(settings.contactPageText).toBe("New contact");
    });
  });

  describe("getTermsAndConditionsFromDb", () => {
    test("returns empty string when not set", () => {
      expect(settings.terms).toBe("");
    });

    test("returns value after update", async () => {
      await settings.update.terms("Terms text");
      expect(settings.terms).toBe("Terms text");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.update.terms("Old terms");
      expect(settings.terms).toBe("Old terms");
      await settings.update.terms("New terms");
      expect(settings.terms).toBe("New terms");
    });

    test("returns empty string after clearing with empty string", async () => {
      await settings.update.terms("Terms");
      expect(settings.terms).toBe("Terms");
      await settings.update.terms("");
      expect(settings.terms).toBe("");
    });
  });

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

      await getDb().execute({
        args: [newValue, CONFIG_KEYS.TERMS_AND_CONDITIONS],
        sql: "UPDATE settings SET value = ? WHERE key = ?",
      });
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
      await getDb().execute({
        args: [newEncrypted, CONFIG_KEYS.WEBSITE_TITLE],
        sql: "UPDATE settings SET value = ? WHERE key = ?",
      });

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
      const { settings: s } = await import("#shared/db/settings.ts");
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
      await getDb().execute({
        args: [CONFIG_KEYS.TERMS_AND_CONDITIONS, "Surprise"],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      });

      // Page cache still holds ""
      expect(settings.terms).toBe("");
    });
  });
});
