import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildReplacer,
  getLocale,
  getRegisteredLocales,
  parseAcceptLanguage,
  runWithLocale,
  setI18nReplacerForTest,
  t,
} from "#i18n";
import { setTestEnv } from "#test-utils";

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
      expect(t("admin.listings.failed_payments_count", { count: 1 })).toContain(
        "1 attendee",
      );
      expect(t("admin.listings.failed_payments_count", { count: 5 })).toContain(
        "5 attendees",
      );
    });
  });

  describe("buildReplacer", () => {
    test("is an identity replacer when unset", () => {
      expect(buildReplacer(undefined)("Foo bar")).toBe("Foo bar");
    });

    test("is an identity replacer for an empty spec", () => {
      expect(buildReplacer("")("Foo bar")).toBe("Foo bar");
    });

    test("is an identity replacer when no pair is valid", () => {
      // "nopipe" has no "|", so there is nothing to replace.
      expect(buildReplacer("nopipe")("nopipe")).toBe("nopipe");
    });

    test("replaces a lowercase substring with the lowercase form", () => {
      expect(buildReplacer("foo|bar")("foobar")).toBe("barbar");
    });

    test("copies title-case capitalisation from the source", () => {
      expect(buildReplacer("foo|bar")("Foo")).toBe("Bar");
    });

    test("matches case-insensitively but keeps each occurrence's own case", () => {
      expect(buildReplacer("foo|bar")("Foo and foo")).toBe("Bar and bar");
    });

    test("normalises the spec's replacement so the source's case wins", () => {
      // The replacement is written title-case in the spec, but the source
      // word's capitalisation — not the spec's — decides the output.
      const replace = buildReplacer("foo|Bar");
      expect(replace("foo")).toBe("bar");
      expect(replace("Foo")).toBe("Bar");
    });

    test("applies every configured pair", () => {
      expect(buildReplacer("foo|bar,baz|bee")("Foo baz")).toBe("Bar bee");
    });

    test("skips blank and half-written pairs without dropping later ones", () => {
      // Empty pair (",,") and a missing replacement ("baz|") are both ignored,
      // so "baz" survives untouched while "foo" is still replaced.
      expect(buildReplacer("foo|bar,,baz|")("foo baz")).toBe("bar baz");
    });

    test("uses the first definition when a term is repeated", () => {
      expect(buildReplacer("foo|bar,foo|qux")("foo")).toBe("bar");
    });

    test("prefers the longest matching term", () => {
      // Without longest-first ordering "foo" would match and leave "bar".
      expect(buildReplacer("foo|x,foobar|y")("foobar")).toBe("y");
    });

    test("treats regex metacharacters in a term literally", () => {
      const replace = buildReplacer("a.c|x");
      expect(replace("a.c")).toBe("x");
      expect(replace("abc")).toBe("abc");
    });

    test("leaves a term untouched when it follows a slash (path segment)", () => {
      expect(buildReplacer("attendees|guests")("/admin/attendees")).toBe(
        "/admin/attendees",
      );
    });

    test("leaves a term untouched when it precedes a slash (path segment)", () => {
      expect(buildReplacer("foo|bar")("foo/baz")).toBe("foo/baz");
    });

    test("rebrands a link's label but not its href path", () => {
      // The visible "Attendees" is rewritten; the /admin/attendees route in the
      // href is a path segment and must survive so the link keeps working.
      expect(
        buildReplacer("attendee|guest")(
          '<a href="/admin/attendees">Attendees</a>',
        ),
      ).toBe('<a href="/admin/attendees">Guests</a>');
    });

    test("leaves route examples shown in body text intact", () => {
      expect(
        buildReplacer("listing|event")("See /api/admin/listings/:id"),
      ).toBe("See /api/admin/listings/:id");
    });
  });

  describe("t with I18N_REPLACEMENTS", () => {
    const withReplacements = (
      spec: string | undefined,
      fn: () => void,
    ): void => {
      const restore = setTestEnv({ I18N_REPLACEMENTS: spec });
      setI18nReplacerForTest(null); // force a rebuild from the new env
      try {
        fn();
      } finally {
        restore();
        setI18nReplacerForTest(null); // reset cache for the next test/file
      }
    };

    test("rewrites rendered values, copying the source's case", () => {
      // common.yes is "Yes"; "yes|aye" rewrites it in title case.
      withReplacements("yes|aye", () => {
        expect(t("common.yes")).toBe("Aye");
      });
    });

    test("rewrites interpolated ICU values too", () => {
      withReplacements("gala|fete", () => {
        expect(
          t("admin.attendees.refund_all_confirm", { name: "Gala" }),
        ).toContain('"Fete"');
      });
    });

    test("never rewrites the fallback key path of a missing translation", () => {
      // A missing key is returned verbatim; "key" must not become "code"
      // even though the substring matches.
      withReplacements("key|code", () => {
        expect(t("unknown.key.that.does.not.exist")).toBe(
          "unknown.key.that.does.not.exist",
        );
      });
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
