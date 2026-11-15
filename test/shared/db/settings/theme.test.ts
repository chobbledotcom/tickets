import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectStoredSetting } from "#test-utils/settings-accessors.ts";

describeWithEnv(
  "settings theme and underline links from DB",
  { db: true },
  () => {
    const theme = {
      read: () => settings.theme,
      update: settings.update.theme,
    };
    const underlineLinks = {
      read: () => settings.underlineLinks,
      update: settings.update.underlineLinks,
    };

    beforeEach(() => {
      settings.clearTestOverride("theme", "underline_links");
    });

    test("loads light theme from database by default", () => {
      expect(settings.theme).toBe("light");
    });

    test("underlining links is off by default", () => {
      expect(settings.underlineLinks).toBe(false);
    });

    test("loads dark theme after updating database", async () => {
      await expectStoredSetting(theme, "dark");
    });

    test("turns underlining on after updating to true", async () => {
      await expectStoredSetting(underlineLinks, true);
    });

    test("turns underlining back off after updating to false", async () => {
      await settings.update.underlineLinks(true);
      await expectStoredSetting(underlineLinks, false);
    });
  },
);
