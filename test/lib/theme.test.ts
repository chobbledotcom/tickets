import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getTheme,
  loadTheme,
  resetTheme,
  setThemeForTest,
} from "#lib/theme.ts";
import { createTestDbWithSetup, resetDb, setupTestEncryptionKey } from "#test-utils";
import { updateTheme } from "#lib/db/settings.ts";

describe("theme", () => {
  afterEach(() => {
    resetTheme();
  });

  describe("getTheme", () => {
    test("defaults to light", () => {
      expect(getTheme()).toBe("light");
    });

    test("returns value set by setThemeForTest", () => {
      setThemeForTest("dark");
      expect(getTheme()).toBe("dark");
    });
  });

  describe("resetTheme", () => {
    test("resets to light after being set to dark", () => {
      setThemeForTest("dark");
      resetTheme();
      expect(getTheme()).toBe("light");
    });
  });

  describe("loadTheme", () => {
    beforeEach(async () => {
      setupTestEncryptionKey();
      await createTestDbWithSetup();
      resetTheme();
    });

    afterEach(() => {
      resetDb();
    });

    test("loads light theme from database by default", async () => {
      const theme = await loadTheme();
      expect(theme).toBe("light");
    });

    test("loads dark theme after updating database", async () => {
      await updateTheme("dark");
      const theme = await loadTheme();
      expect(theme).toBe("dark");
    });

    test("makes theme available via getTheme after loading", async () => {
      await updateTheme("dark");
      await loadTheme();
      expect(getTheme()).toBe("dark");
    });
  });
});
