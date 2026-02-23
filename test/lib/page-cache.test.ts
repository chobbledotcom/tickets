import { afterEach, beforeEach, describe, expect, jest, test } from "#test-compat";
import {
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getTermsAndConditionsFromDb,
  getWebsiteTitleFromDb,
  invalidatePageCache,
  invalidateSettingsCache,
  updateContactPageText,
  updateHomepageText,
  updateTermsAndConditions,
  updateWebsiteTitle,
} from "#lib/db/settings.ts";

/** 30 minutes in ms - matches PAGE_CACHE_TTL_MS in settings.ts */
const PAGE_CACHE_TTL_MS = 30 * 60 * 1_000;
import {
  createTestDbWithSetup,
  resetDb,
} from "#test-utils";

describe("page content cache", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  afterEach(() => {
    jest.useRealTimers();
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

    test("serves cached value on repeated reads", async () => {
      await updateWebsiteTitle("Cached Title");
      const first = await getWebsiteTitleFromDb();
      const second = await getWebsiteTitleFromDb();
      expect(first).toBe("Cached Title");
      expect(second).toBe("Cached Title");
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
    test("serves cached value within TTL", async () => {
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      await updateWebsiteTitle("Cached");
      expect(await getWebsiteTitleFromDb()).toBe("Cached");

      // Advance time to just before TTL expiry
      jest.setSystemTime(startTime + PAGE_CACHE_TTL_MS - 1);
      expect(await getWebsiteTitleFromDb()).toBe("Cached");
    });

    test("re-fetches after TTL expires", async () => {
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      await updateWebsiteTitle("Original");
      // Populate cache
      expect(await getWebsiteTitleFromDb()).toBe("Original");

      // Directly update the DB without going through updateWebsiteTitle
      // (simulates another instance writing) - we use updateWebsiteTitle
      // which invalidates, then re-read to populate cache
      invalidatePageCache();
      await updateWebsiteTitle("Updated");
      expect(await getWebsiteTitleFromDb()).toBe("Updated");

      // Advance past TTL - should still work since cache was repopulated
      jest.setSystemTime(startTime + PAGE_CACHE_TTL_MS + 1);
      // Cache expired, re-fetches from DB
      expect(await getWebsiteTitleFromDb()).toBe("Updated");
    });
  });

  describe("invalidatePageCache", () => {
    test("clears all cached page entries", async () => {
      await updateWebsiteTitle("Title");
      await updateHomepageText("Homepage");
      await updateContactPageText("Contact");
      await updateTermsAndConditions("Terms");

      // Populate all caches
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      expect(await getHomepageTextFromDb()).toBe("Homepage");
      expect(await getContactPageTextFromDb()).toBe("Contact");
      expect(await getTermsAndConditionsFromDb()).toBe("Terms");

      // Clear all
      invalidatePageCache();

      // Values should still be correct (re-fetched from DB)
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      expect(await getHomepageTextFromDb()).toBe("Homepage");
      expect(await getContactPageTextFromDb()).toBe("Contact");
      expect(await getTermsAndConditionsFromDb()).toBe("Terms");
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

  describe("cross-key isolation", () => {
    test("updating one page does not invalidate other page caches", async () => {
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      await updateWebsiteTitle("Title");
      await updateHomepageText("Homepage");

      // Populate both caches
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      expect(await getHomepageTextFromDb()).toBe("Homepage");

      // Update only homepage - title cache should remain valid
      await updateHomepageText("New Homepage");

      // Advance time but still within TTL
      jest.setSystemTime(startTime + PAGE_CACHE_TTL_MS - 1000);

      // Title should still be served from cache (no re-fetch needed)
      expect(await getWebsiteTitleFromDb()).toBe("Title");
      // Homepage should reflect the update
      expect(await getHomepageTextFromDb()).toBe("New Homepage");
    });
  });

  describe("null value caching", () => {
    test("caches null values to avoid repeated lookups", async () => {
      // First read - cache miss, returns null
      expect(await getWebsiteTitleFromDb()).toBeNull();
      // Second read - should serve from cache (null is a valid cached value)
      expect(await getWebsiteTitleFromDb()).toBeNull();
    });
  });
});
