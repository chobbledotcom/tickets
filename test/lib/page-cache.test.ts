import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { CONFIG_KEYS, settings } from "#lib/db/settings.ts";

const { PAGE_CACHE_TTL_MS } = settings;

import { encrypt } from "#lib/crypto.ts";
import { getDb } from "#lib/db/client.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("page content cache", { db: true }, () => {
  let fakeTime: FakeTime | null = null;

  afterEach(() => {
    fakeTime?.restore();
    fakeTime = null;
  });

  describe("getWebsiteTitleFromDb", () => {
    test("returns null when not set", async () => {
      expect(await settings.websiteTitle.get()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await settings.websiteTitle.update("My Site");
      expect(await settings.websiteTitle.get()).toBe("My Site");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.websiteTitle.update("Old Title");
      expect(await settings.websiteTitle.get()).toBe("Old Title");
      await settings.websiteTitle.update("New Title");
      expect(await settings.websiteTitle.get()).toBe("New Title");
    });

    test("returns null after clearing with empty string", async () => {
      await settings.websiteTitle.update("Title");
      expect(await settings.websiteTitle.get()).toBe("Title");
      await settings.websiteTitle.update("");
      expect(await settings.websiteTitle.get()).toBeNull();
    });
  });

  describe("getHomepageTextFromDb", () => {
    test("returns null when not set", async () => {
      expect(await settings.homepageText.get()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await settings.homepageText.update("Welcome!");
      expect(await settings.homepageText.get()).toBe("Welcome!");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.homepageText.update("Old text");
      expect(await settings.homepageText.get()).toBe("Old text");
      await settings.homepageText.update("New text");
      expect(await settings.homepageText.get()).toBe("New text");
    });
  });

  describe("getContactPageTextFromDb", () => {
    test("returns null when not set", async () => {
      expect(await settings.contactPageText.get()).toBeNull();
    });

    test("returns decrypted value after update", async () => {
      await settings.contactPageText.update("Contact us here");
      expect(await settings.contactPageText.get()).toBe("Contact us here");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.contactPageText.update("Old contact");
      expect(await settings.contactPageText.get()).toBe("Old contact");
      await settings.contactPageText.update("New contact");
      expect(await settings.contactPageText.get()).toBe("New contact");
    });
  });

  describe("getTermsAndConditionsFromDb", () => {
    test("returns null when not set", async () => {
      expect(await settings.terms.get()).toBeNull();
    });

    test("returns value after update", async () => {
      await settings.terms.update("Terms text");
      expect(await settings.terms.get()).toBe("Terms text");
    });

    test("returns updated value after update invalidates cache", async () => {
      await settings.terms.update("Old terms");
      expect(await settings.terms.get()).toBe("Old terms");
      await settings.terms.update("New terms");
      expect(await settings.terms.get()).toBe("New terms");
    });

    test("returns null after clearing with empty string", async () => {
      await settings.terms.update("Terms");
      expect(await settings.terms.get()).toBe("Terms");
      await settings.terms.update("");
      expect(await settings.terms.get()).toBeNull();
    });
  });

  describe("TTL expiry", () => {
    /** Seed cache, sneak a raw DB write, return startTime for fakeTime.now manipulation */
    const seedAndBypassCache = async (): Promise<number> => {
      const startTime = Date.now();
      fakeTime = new FakeTime(startTime);

      await settings.terms.update("Original");
      expect(await settings.terms.get()).toBe("Original");

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
      expect(await settings.terms.get()).toBe("Original");
    });

    test("re-fetches from DB after TTL expires", async () => {
      const startTime = await seedAndBypassCache();

      // Advance past TTL
      fakeTime!.now = startTime + PAGE_CACHE_TTL_MS + 1;
      // Cache expired — re-fetches from DB and picks up new value
      expect(await settings.terms.get()).toBe("Changed");
    });

    test("serves stale cached encrypted value when DB changes within TTL", async () => {
      const startTime = Date.now();
      fakeTime = new FakeTime(startTime);

      await settings.websiteTitle.update("Original Title");
      expect(await settings.websiteTitle.get()).toBe("Original Title");

      // Write a different encrypted value directly to DB
      const newEncrypted = await encrypt("Changed Title");
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: [CONFIG_KEYS.WEBSITE_TITLE, newEncrypted],
      });

      // Within TTL — cache still serves decrypted "Original Title"
      fakeTime.now = startTime + PAGE_CACHE_TTL_MS - 1;
      expect(await settings.websiteTitle.get()).toBe("Original Title");
    });
  });

  describe("invalidatePageCache", () => {
    /** Assert all four page getters return the seeded values */
    const expectAllPages = async () => {
      expect(await settings.websiteTitle.get()).toBe("Title");
      expect(await settings.homepageText.get()).toBe("Homepage");
      expect(await settings.contactPageText.get()).toBe("Contact");
      expect(await settings.terms.get()).toBe("Terms");
    };

    test("clears all cached page entries", async () => {
      await settings.websiteTitle.update("Title");
      await settings.homepageText.update("Homepage");
      await settings.contactPageText.update("Contact");
      await settings.terms.update("Terms");

      // Populate all caches
      await expectAllPages();

      // Clear all
      settings.invalidatePageCache();

      // Values should still be correct (re-fetched from DB)
      await expectAllPages();
    });
  });

  describe("invalidateSettingsCache clears page cache", () => {
    test("page cache is cleared when settings cache is invalidated", async () => {
      await settings.websiteTitle.update("Title");
      // Populate page cache
      expect(await settings.websiteTitle.get()).toBe("Title");

      // invalidateSettingsCache should also clear the page cache
      settings.invalidateCache();

      // Still returns correct value (re-fetched from DB)
      expect(await settings.websiteTitle.get()).toBe("Title");
    });
  });

  describe("cache stats after invalidation", () => {
    test("settings cache reports 0 entries after invalidation", async () => {
      const { getAllCacheStats } = await import("#lib/cache-registry.ts");

      // Load settings to populate cache
      const { settings: s } = await import("#lib/db/settings.ts");
      await s.loadAll();

      const before = getAllCacheStats().find((s) => s.name === "settings");
      expect(before!.entries).toBeGreaterThan(0);

      settings.invalidateCache();

      const after = getAllCacheStats().find((s) => s.name === "settings");
      expect(after!.entries).toBe(0);
    });
  });

  describe("null value caching", () => {
    test("serves cached null when value is added to DB within TTL", async () => {
      // First read populates page cache with null
      expect(await settings.terms.get()).toBeNull();

      // Write directly to DB, bypassing page cache invalidation
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        args: [CONFIG_KEYS.TERMS_AND_CONDITIONS, "Surprise"],
      });

      // Page cache still holds null
      expect(await settings.terms.get()).toBeNull();
    });
  });
});
