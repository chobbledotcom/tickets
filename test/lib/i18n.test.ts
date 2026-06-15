import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getLocale,
  getRegisteredLocales,
  parseAcceptLanguage,
  runWithLocale,
  t,
} from "#i18n";

describe("i18n", () => {
  describe("t", () => {
    test("returns translated string for known key", () => {
      expect(t("common.yes")).toBe("Yes");
    });

    test("returns key for unknown key", () => {
      expect(t("unknown.key.that.does.not.exist")).toBe(
        "unknown.key.that.does.not.exist",
      );
    });

    test("interpolates values using ICU MessageFormat", () => {
      // Use a key with known ICU parameters
      expect(t("admin.attendees.refund_all_confirm", { name: "Gala" })).toBe(
        'To refund all attendees, you must type the listing name "Gala" into the box below:',
      );
    });

    test("handles ICU plural format", () => {
      expect(t("admin.attendees.refund_all_warning", { count: 1 })).toContain(
        "1 attendee",
      );
      expect(t("admin.attendees.refund_all_warning", { count: 5 })).toContain(
        "5 attendees",
      );
    });
  });

  describe("getRegisteredLocales", () => {
    test("includes en by default", () => {
      expect(getRegisteredLocales()).toContain("en");
    });
  });

  describe("runWithLocale", () => {
    test("sets locale within callback", () => {
      const result = runWithLocale("de", () => getLocale());
      expect(result).toBe("de");
    });

    test("defaults to en outside callback", () => {
      expect(getLocale()).toBe("en");
    });
  });

  describe("parseAcceptLanguage", () => {
    test("returns en for null header", () => {
      expect(parseAcceptLanguage(null)).toBe("en");
    });

    test("returns exact match for registered locale", () => {
      expect(parseAcceptLanguage("en")).toBe("en");
    });

    test("returns base language match", () => {
      expect(parseAcceptLanguage("en-GB,de;q=0.8")).toBe("en");
    });

    test("skips higher-q unregistered locales for a registered one", () => {
      expect(parseAcceptLanguage("xx;q=1.0,en;q=0.5")).toBe("en");
    });

    test("falls back to en for unregistered locales", () => {
      expect(parseAcceptLanguage("xx-YY")).toBe("en");
    });
  });
});
