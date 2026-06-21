import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildReplacer,
  getLocale,
  getRegisteredLocales,
  parseAcceptLanguage,
  resetI18nForTest,
  runWithLocale,
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

    test("rebrands a link's label but not its href or tag markup", () => {
      // The visible "Attendees" is rewritten; the <a> tag and its
      // /admin/attendees href are protected so the link keeps working.
      expect(
        buildReplacer("attendee|guest")(
          '<a href="/admin/attendees">Attendees</a>',
        ),
      ).toBe('<a href="/admin/attendees">Guests</a>');
    });

    test("leaves route examples inside <code> intact while rebranding prose", () => {
      // The plus-separated slugs in the code example must survive verbatim even
      // though "listing" is not slash-adjacent; surrounding prose still changes.
      expect(
        buildReplacer("listing|event")(
          "A listing at <code>/ticket/listing-one+listing-two</code>",
        ),
      ).toBe("A event at <code>/ticket/listing-one+listing-two</code>");
    });

    test("rebrands copy inside ICU plural sub-messages", () => {
      expect(
        buildReplacer("ticket|booking")(
          "{count, plural, one {# ticket} other {# tickets}}",
        ),
      ).toBe("{count, plural, one {# booking} other {# bookings}}");
    });
  });

  describe("t with I18N_REPLACEMENTS", () => {
    const withReplacements = (
      spec: string | undefined,
      fn: () => void,
    ): void => {
      const restore = setTestEnv({ I18N_REPLACEMENTS: spec });
      resetI18nForTest(); // force a rebuild + recompile from the new env
      try {
        fn();
      } finally {
        restore();
        resetI18nForTest(); // reset caches for the next test/file
      }
    };

    test("rewrites the static copy of a message, copying the source's case", () => {
      // common.yes is "Yes"; "yes|aye" rewrites it in title case.
      withReplacements("yes|aye", () => {
        expect(t("common.yes")).toBe("Aye");
      });
    });

    test("rewrites copy but never the interpolated data values", () => {
      // The "attendees" in the template copy becomes "guests", but the listing
      // name supplied at render time is data and must survive verbatim — the
      // POST handler verifies the typed name against the stored original.
      withReplacements("attendee|guest", () => {
        const out = t("admin.attendees.refund_all_confirm", {
          name: "Attendee Gala",
        });
        expect(out).toContain('"Attendee Gala"'); // data untouched
        expect(out).toContain("all guests"); // copy rebranded
      });
    });

    test("never rewrites the fallback key of a missing translation", () => {
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
