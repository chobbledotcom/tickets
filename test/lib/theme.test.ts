import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#lib/db/settings.ts";
import { resetTheme, setThemeForTest } from "#lib/theme.ts";
import { describeWithEnv } from "#test-utils";

describe("theme", () => {
  afterEach(() => {
    resetTheme();
  });

  describe("settings.theme", () => {
    test("defaults to light", () => {
      expect(settings.theme).toBe("light");
    });

    test("returns value set by setThemeForTest", () => {
      setThemeForTest("dark");
      expect(settings.theme).toBe("dark");
    });
  });

  describe("resetTheme", () => {
    test("resets to light after being set to dark", () => {
      setThemeForTest("dark");
      resetTheme();
      expect(settings.theme).toBe("light");
    });
  });

  describeWithEnv("settings.theme from DB", { db: true }, () => {
    beforeEach(() => {
      resetTheme();
    });

    test("loads light theme from database by default", () => {
      expect(settings.theme).toBe("light");
    });

    test("loads dark theme after updating database", async () => {
      await settings.update.theme("dark");
      expect(settings.theme).toBe("dark");
    });
  });
});
