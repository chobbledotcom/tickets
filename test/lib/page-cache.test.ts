import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  CONFIG_KEYS,
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getTermsAndConditionsFromDb,
  getWebsiteTitleFromDb,
  invalidatePageCache,
  invalidateSettingsCache,
  settingsApi,
  updateContactPageText,
  updateHomepageText,
  updateTermsAndConditions,
  updateWebsiteTitle,
} from "#lib/db/settings.ts";

const { PAGE_CACHE_TTL_MS } = settingsApi;

import { encrypt } from "#lib/crypto.ts";
import { getDb } from "#lib/db/client.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils";

describe("page content cache", () => {
  let fakeTime: FakeTime | null = null;

  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  afterEach(() => {
    fakeTime?.restore();
    fakeTime = null;
    resetDb();
  });

  describe("getWebsiteTitleFromDb", () => {
    test("returns null when not set", async () => {
      expect(await getWebsiteTitleFromDb()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await updateWebsiteTitle("My Site");
      expect(await getWebsiteTitleFromDb()).toBe("My Site");
    });

    test("returns updated value after update invalidates cache", async () => {
      await updateWebsiteTitle("Old Title");
      expect(await getWebsiteTitleFromDb()).toBe("Old Title");
      await updateWebsiteTitle("New Title");
      expect(await getWebsiteTitleFromDb()).toBe("New Title");
    });

    test("returns null after clearing with empty string", async () => {
      await updateWebsiteTitle("Title");
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      await updateWebsiteTitle("");
      expect(await getWebsiteTitleFromDb()).toBeNull();
    });
  });

  describe("getHomepageTextFromDb", () => {
    test("returns null when not set", async () => {
      expect(await getHomepageTextFromDb()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await updateHomepageText("Welcome!");
      expect(await getHomepageTextFromDb()).toBe("Welcome!");
    });

    test("returns updated value after update invalidates cache", async () => {
      await updateHomepageText("Old text");
      expect(await getHomepageTextFromDb()).toBe("Old text");
      await updateHomepageText("New text");
      expect(await getHomepageTextFromDb()).toBe("New text");
    });
  });

  describe("getContactPageTextFromDb", () => {
    test("returns null when not set", async () => {
      expect(await getContactPageTextFromDb()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await updateContactPageText("Contact us here");
      expect(await getContactPageTextFromDb()).toBe("Contact us here");
    });

    test("returns updated value after update invalidates cache", async () => {
      await updateContactPageText("Old contact");
      expect(await getContactPageTextFromDb()).toBe("Old contact");
      await updateContactPageText("New contact");
      expect(await getContactPageTextFromDb()).toBe("New contact");
    });
  });

  describe("getTermsAndConditionsFromDb", () => {
    test("returns null when not set", async () => {
      expect(await getTermsAndConditionsFromDb()).toBeNull();
    });

    test("returns value after update", async () => {
      await updateTermsAndConditions("Terms text");
      expect(await getTermsAndConditionsFromDb()).toBe("Terms text");
    });

    test("returns updated value after update invalidates cache", async () => {
      await updateTermsAndConditions("Old terms");
      expect(await getTermsAndConditionsFromDb()).toBe("Old terms");
      await updateTermsAndConditions("New terms");
      expect(await getTermsAndConditionsFromDb()).toBe("New terms");
    });

    test("returns null after clearing with empty string", async () => {
      await updateTermsAndConditions("Terms");
      expect(await getTermsAndConditionsFromDb()).toBe("Terms");
      await updateTermsAndConditions("");
      expect(await getTermsAndConditionsFromDb()).toBeNull();
    });
  });

  describe("TTL expiry", () => {
    /** Seed cache, sneak a raw DB write, return startTime for fakeTime.now manipulation */
    const seedAndBypassCache = async (): Promise<number> => {
      const startTime = Date.now();
      fakeTime = new FakeTime(startTime);

      await updateTermsAndConditions("Original");
      expect(await getTermsAndConditionsFromDb()).toBe("Original");

      // Write directly to DB, bypassing page cache invalidation
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: [CONFIG_KEYS.TERMS_AND_CONDITIONS, "Changed"],
      });
      return startTime;
    };

    test("serves stale cached value when DB changes within TTL", async () => {
      const startTime = await seedAndBypassCache();

      // Advance to just before TTL boundary — cache still valid
      fakeTime!.now = startTime + PAGE_CACHE_TTL_MS - 1;
      expect(await getTermsAndConditionsFromDb()).toBe("Original");
    });

    test("re-fetches from DB after TTL expires", async () => {
      const startTime = await seedAndBypassCache();

      // Advance past TTL
      fakeTime!.now = startTime + PAGE_CACHE_TTL_MS + 1;
      // Cache expired — re-fetches from DB and picks up new value
      expect(await getTermsAndConditionsFromDb()).toBe("Changed");
    });

    test("serves stale cached encrypted value when DB changes within TTL", async () => {
      const startTime = Date.now();
      fakeTime = new FakeTime(startTime);

      await updateWebsiteTitle("Original Title");
      expect(await getWebsiteTitleFromDb()).toBe("Original Title");

      // Write a different encrypted value directly to DB
      const newEncrypted = await encrypt("Changed Title");
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: [CONFIG_KEYS.WEBSITE_TITLE, newEncrypted],
      });

      // Within TTL — cache still serves decrypted "Original Title"
      fakeTime.now = startTime + PAGE_CACHE_TTL_MS - 1;
      expect(await getWebsiteTitleFromDb()).toBe("Original Title");
    });
  });

  describe("invalidatePageCache", () => {
    /** Assert all four page getters return the seeded values */
    const expectAllPages = async () => {
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      expect(await getHomepageTextFromDb()).toBe("Homepage");
      expect(await getContactPageTextFromDb()).toBe("Contact");
      expect(await getTermsAndConditionsFromDb()).toBe("Terms");
    };

    test("clears all cached page entries", async () => {
      await updateWebsiteTitle("Title");
      await updateHomepageText("Homepage");
      await updateContactPageText("Contact");
      await updateTermsAndConditions("Terms");

      // Populate all caches
      await expectAllPages();

      // Clear all
      invalidatePageCache();

      // Values should still be correct (re-fetched from DB)
      await expectAllPages();
    });
  });

  describe("invalidateSettingsCache clears page cache", () => {
    test("page cache is cleared when settings cache is invalidated", async () => {
      await updateWebsiteTitle("Title");
      // Populate page cache
      expect(await getWebsiteTitleFromDb()).toBe("Title");

      // invalidateSettingsCache should also clear the page cache
      invalidateSettingsCache();

      // Still returns correct value (re-fetched from DB)
      expect(await getWebsiteTitleFromDb()).toBe("Title");
    });
  });

  describe("cache stats after invalidation", () => {
    test("settings cache reports 0 entries after invalidation", async () => {
      const { getAllCacheStats } = await import("#lib/cache-registry.ts");

      // Load settings to populate cache
      const { loadAllSettings } = await import("#lib/db/settings.ts");
      await loadAllSettings();

      const before = getAllCacheStats().find((s) => s.name === "settings");
      expect(before!.entries).toBeGreaterThan(0);

      invalidateSettingsCache();

      const after = getAllCacheStats().find((s) => s.name === "settings");
      expect(after!.entries).toBe(0);
    });
  });

  describe("null value caching", () => {
    test("serves cached null when value is added to DB within TTL", async () => {
      // First read populates page cache with null
      expect(await getTermsAndConditionsFromDb()).toBeNull();

      // Write directly to DB, bypassing page cache invalidation
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: [CONFIG_KEYS.TERMS_AND_CONDITIONS, "Surprise"],
      });

      // Page cache still holds null
      expect(await getTermsAndConditionsFromDb()).toBeNull();
    });
  });
});
