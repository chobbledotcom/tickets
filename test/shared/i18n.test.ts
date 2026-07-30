import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { IntlMessageFormat } from "intl-messageformat";
import {
  buildReplacer,
  getLocale,
  getRegisteredLocales,
  parseAcceptLanguage,
  resetI18nForTest,
  runWithLocale,
  t,
} from "#i18n";
import { withEnv } from "#test-utils/env.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

const en = await allEnglishMessages();

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
      expect(t("tickets.count", { count: 1 })).toBe("1 Ticket");
      expect(t("tickets.count", { count: 5 })).toBe("5 Tickets");
    });

    test("returns a plain message (no ICU placeholder) verbatim", () => {
      // Plain copy takes the fast path that skips IntlMessageFormat entirely,
      // so its output must still equal the exact catalog string.
      expect(t("common.yes")).toBe("Yes");
      expect(t("common.cancel")).toBe("Cancel");
    });

    test("fast path renders every placeholder-free message exactly as full ICU would", () => {
      // The optimisation skips IntlMessageFormat for messages it deems plain.
      // This is the invariant that keeps that safe: for every message carrying
      // no `{` placeholder, t()'s output must equal what a real
      // IntlMessageFormat would have produced. A mis-classification — a `#` or
      // `|` wrongly treated as needing ICU, or an apostrophe message wrongly
      // fast-pathed and losing its `''` escaping — surfaces here. Placeholder
      // messages need render values, so they are out of scope.
      const withoutPlaceholder = Object.entries(
        en as Record<string, string>,
      ).filter(
        ([, value]) => typeof value === "string" && !value.includes("{"),
      );
      // Sanity: most copy is placeholder-free, so this truly exercises the fast
      // path across the catalog rather than a handful of keys.
      expect(withoutPlaceholder.length).toBeGreaterThan(2000);
      for (const [key, value] of withoutPlaceholder) {
        const viaIcu = String(
          new IntlMessageFormat(value, "en", undefined, {
            ignoreTag: true,
          }).format(),
        );
        expect(t(key)).toBe(viaIcu);
      }
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

    /** Render a rebranded template the way `t` would, to check it end to end. */
    const format = (
      template: ReturnType<ReturnType<typeof buildReplacer>>,
      values: Record<string, number | string>,
    ): string =>
      String(
        new IntlMessageFormat(template, "en", undefined, {
          ignoreTag: true,
        }).format(values),
      );

    test("rebrands copy inside ICU plural sub-messages", () => {
      const rebranded = buildReplacer("ticket|booking")(
        "{count, plural, one {# ticket} other {# tickets}}",
      );
      expect(format(rebranded, { count: 1 })).toBe("1 booking");
      expect(format(rebranded, { count: 3 })).toBe("3 bookings");
    });

    test("never rebrands an ICU argument name, even when it matches a term", () => {
      // The handler supplies the value under the argument's exact name, so a
      // rebrand pair like "listing|event" must not touch `{listings, …}` —
      // only the copy inside the branches.
      // Formatting under the original argument name is the proof: a renamed
      // argument would make IntlMessageFormat throw on the missing value.
      const rebranded = buildReplacer("listing|event")(
        "Created {listings, plural, one {# listing} other {# listings}}.",
      );
      expect(format(rebranded, { listings: 3 })).toBe("Created 3 events.");
    });

    test("rebrands a sub-message that is a single bare word", () => {
      // "one {listing}" looks exactly like an argument reference, but it is
      // copy inside a plural branch and must still be rebranded.
      const rebranded = buildReplacer("listing|event")(
        "{count, plural, one {listing} other {listings}}",
      );
      expect(format(rebranded, { count: 1 })).toBe("event");
      expect(format(rebranded, { count: 2 })).toBe("events");
    });

    test("rebrands select branches while keeping the selector working", () => {
      const rebranded = buildReplacer("ticket|booking")(
        "{kind, select, single {A ticket} other {Some tickets}}",
      );
      expect(format(rebranded, { kind: "single" })).toBe("A booking");
      expect(format(rebranded, { kind: "bulk" })).toBe("Some bookings");
    });

    test("keeps a plain argument intact while rebranding the copy around it", () => {
      const rebranded = buildReplacer("attendee|guest")(
        "The attendee {attendee} checked in.",
      );
      expect(format(rebranded, { attendee: "Alice" })).toBe(
        "The guest Alice checked in.",
      );
    });

    test("keeps a <code> example intact when an argument splits it", () => {
      // The argument cuts the <code> span into two literal nodes; the second
      // half must stay protected, while the prose after the span rebrands.
      const rebranded = buildReplacer("listing|event")(
        "Subscribe at <code>https://{domain}/feeds/listings.ics</code> for listings.",
      );
      expect(format(rebranded, { domain: "example.com" })).toBe(
        "Subscribe at <code>https://example.com/feeds/listings.ics</code> for events.",
      );
    });

    test("keeps ICU apostrophe escaping working in a rebranded template", () => {
      // '' is an escaped literal apostrophe; the rebranded template must keep
      // it as one, not turn it into a quote that swallows the argument.
      const rebranded = buildReplacer("listing|event")(
        "Saved ''{value}'' to the listing.",
      );
      expect(format(rebranded, { value: "Note" })).toBe(
        "Saved 'Note' to the event.",
      );
    });
  });

  describe("t with I18N_REPLACEMENTS", () => {
    const withReplacements = (
      spec: string | undefined,
      fn: () => void,
    ): void => {
      using _env = withEnv({ I18N_REPLACEMENTS: spec });
      resetI18nForTest(); // force a rebuild + recompile from the new env
      try {
        fn();
      } finally {
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

    test("keeps an empty-string locale rather than defaulting to en", () => {
      // getLocale coalesces only a *missing* store (undefined) to "en" using
      // `??`; an explicitly-set empty string is a real (if odd) value and must
      // survive. This pins `??` so it can't weaken to `||`, which would also
      // swallow "".
      expect(runWithLocale("", () => getLocale())).toBe("");
    });
  });

  describe("parseAcceptLanguage", () => {
    // A two-locale list where "de" is registered but is NOT the "en" fallback,
    // so a parsing/sorting bug that mis-picks surfaces as en-instead-of-de
    // rather than hiding behind the fallback.
    const REG = ["de", "en"];

    test("returns en for null header", () => {
      expect(parseAcceptLanguage(null)).toBe("en");
    });

    test("uses the live locale list by default (en is registered)", () => {
      // Exercises the `registered = getRegisteredLocales()` default argument.
      expect(parseAcceptLanguage("en")).toBe("en");
    });

    test("returns base language match", () => {
      expect(parseAcceptLanguage("en-GB,de;q=0.8")).toBe("en");
    });

    test("splits the header on commas to consider each language", () => {
      // Kills split(",") → split(""): with a proper split "de" is a whole
      // token and wins; a per-character split never yields the "de" token.
      expect(parseAcceptLanguage("de,en", REG)).toBe("de");
    });

    test("splits a tagged entry on ';' to read its language", () => {
      // Kills split(";") → split(""): "de;q=0.9" must yield lang "de", not "d".
      expect(parseAcceptLanguage("de;q=0.9", REG)).toBe("de");
    });

    test("reads the q value from the part after the first ';'", () => {
      // Kills Number(qMatch[1]) → Number(qMatch[0]): the captured group is the
      // number; the whole match "q=0.9" is NaN and would drop the entry.
      expect(parseAcceptLanguage("de;q=0.9,en;q=0.1", REG)).toBe("de");
    });

    test("rejoins extra ';' parts before reading q so a later q= is still found", () => {
      // Kills rest.join(";") → rest.join(""): dropping the ';' when rejoining a
      // multi-';' segment changes where "q=" is found, flipping the winner.
      expect(parseAcceptLanguage("de;x;q=0.4,en;q=0.5", REG)).toBe("en");
      expect(parseAcceptLanguage("de;xq;=0.4,en;q=0.5", REG)).toBe("de");
    });

    test("defaults a q-less entry to 1 (highest priority), not 0", () => {
      // Kills the `: 1` default → `: 0`: "de" has no q, so it must win over a
      // lower explicit q; a 0 default would drop it below en.
      expect(parseAcceptLanguage("de,en;q=0.5", REG)).toBe("de");
    });

    test("treats a missing quality as equal to an explicit 1", () => {
      expect(parseAcceptLanguage("en;q=1,de", REG)).toBe("en");
    });

    test("drops an entry whose q is zero", () => {
      // Kills `e.lang && e.q > 0` → `||` and `> 0` → `<= 0`/`> 1`: a q=0 entry
      // must be discarded, so de with q=0 loses to the en fallback.
      expect(parseAcceptLanguage("de;q=0", REG)).toBe("en");
    });

    test("orders entries by descending q, highest first", () => {
      // Kills the sort comparator `b.q - a.q` → `b.q / a.q`: en has the higher
      // q and must win even though de appears... en appears first here, and de
      // second with lower q, so en must stay the winner.
      expect(parseAcceptLanguage("en;q=0.9,de;q=0.1", REG)).toBe("en");
    });

    test("skips higher-q unregistered locales for a registered one", () => {
      expect(parseAcceptLanguage("xx;q=1.0,en;q=0.5", REG)).toBe("en");
    });

    test("matches on the base language before the '-'", () => {
      // Kills split("-") → split("") and [0] → [1]: "de-CH" must reduce to base
      // "de", not "d" (char split) or "CH" (second segment).
      expect(parseAcceptLanguage("de-CH", REG)).toBe("de");
    });

    test("falls back to en for unregistered locales", () => {
      expect(parseAcceptLanguage("xx-YY", REG)).toBe("en");
    });
  });
});
