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
import en from "#locales/en/index.ts";
import { setTestEnv } from "#test-utils/env.ts";

describe("i18n", () => {
  describe("t", () => {
    test("returns translated string for known key", () => {
      expect(t("common.yes")).toBe("Yes");
    });

    test("throws for an unknown key", () => {
      // A missing translation is a programming error (typically a dynamically
      // built key whose value was never added), so t() fails loudly rather than
      // silently rendering the raw key to users.
      expect(() => t("unknown.key.that.does.not.exist")).toThrow(
        'Missing translation for key "unknown.key.that.does.not.exist"',
      );
    });

    test("interpolates values using ICU MessageFormat", () => {
      // Use a key with known ICU parameters
      expect(t("admin.attendees.refund_all_confirm", { name: "Gala" })).toBe(
        'To refund all attendees, you must type the listing name "Gala" into the box below:',
      );
    });

    test("interpolates a value wrapped in literal quotes (ICU '' escaping), not just a bare placeholder", () => {
      // Regression: these locale strings wrap the interpolated name in literal
      // single quotes for display (`'{name}'`), which in ICU MessageFormat
      // syntax requires doubled quotes (`''{name}''`) — a single quote pair
      // is parsed as an escaped literal region, leaving `{name}` unsubstituted
      // (and the quote marks themselves stripped) if written with only one
      // quote each side. Covers every key across the two locale files that
      // had this mistake.
      expect(
        t("listings_table.children_err_parent_is_child", { name: "Retreat" }),
      ).toBe(
        "'Retreat' is itself offered as a child of another listing, so it can't also be a parent.",
      );
      expect(
        t("listings_table.children_err_child_is_parent", { name: "Retreat" }),
      ).toBe(
        "'Retreat' already has its own child listings, so it can't also be a child.",
      );
      expect(
        t("listings_table.children_err_child_addon", {
          addon: "Extra",
          name: "Retreat",
        }),
      ).toBe(
        "'Retreat' has the opt-in add-on 'Extra', which only its own booking page offers — make it reachable from the parent (or remove the add-on) before offering it as a child.",
      );
      expect(t("modifiers.err_child_only_addon", { name: "Retreat" })).toBe(
        "'Retreat' is an opt-in add-on reachable only through a required child listing, so no booking page would offer it — scope it to the parent (or another bookable listing), or remove it as a child, before saving.",
      );
      // The logistics "saved" flash wraps the attendee name the same way; a
      // single-quoted `'{value}'` would have shown the literal text `{value}`.
      expect(t("attendee_logistics.saved", { value: "Retreat" })).toBe(
        "Logistics saved for 'Retreat'",
      );
    });

    test("no locale message single-quotes a whole placeholder (ICU escaping trap)", () => {
      // In ICU MessageFormat a lone `'` immediately before `{` starts a quoted
      // literal, so `'{value}'` renders the literal text `{value}` with the
      // value never substituted (and the quote marks stripped). To wrap an
      // interpolated value in literal single quotes the quotes must be doubled
      // (`''{value}''`). This scans every locale string for the single-quote
      // form so the bug can't be reintroduced in a new message. The doubled
      // form is excluded by the lookarounds; deliberate brace escaping like
      // `'{'` (settings.advanced.custom_css_placeholder) never matches because
      // there is no `{identifier}` between the quotes.
      const SINGLE_QUOTED_PLACEHOLDER = /(?<!')'\{[A-Za-z_$][\w$]*\}'(?!')/;
      const offenders = Object.entries(en as Record<string, string>)
        .filter(([, value]) => SINGLE_QUOTED_PLACEHOLDER.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      expect(offenders).toEqual([]);
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

    test("a missing translation throws rather than being rebranded", () => {
      // Replacements rewrite copy, never keys — a missing key throws outright,
      // so "key" is never reachable to be turned into "code".
      withReplacements("key|code", () => {
        expect(() => t("unknown.key.that.does.not.exist")).toThrow(
          'Missing translation for key "unknown.key.that.does.not.exist"',
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
