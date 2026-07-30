import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { IntlMessageFormat } from "intl-messageformat";
import { buildReplacer } from "#shared/rebrand.ts";

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

  test("keeps a tag's attributes intact when an argument splits the tag", () => {
    // The argument sits inside the href, cutting the <a> tag across three
    // nodes. The route in the href must survive; the link's visible label
    // and the prose after it still rebrand.
    const rebranded = buildReplacer("listing|event")(
      'See <a href="/listings/{id}/edit">the listing</a> for listings.',
    );
    expect(format(rebranded, { id: 7 })).toBe(
      'See <a href="/listings/7/edit">the event</a> for events.',
    );
  });

  test("every plural branch starts inside the same open <code> span", () => {
    // The whole plural sits inside one <code> example. The first branch must
    // not leak state that unprotects the later branches: both keep their
    // code text verbatim, and the prose after the span still rebrands.
    const rebranded = buildReplacer("listing|event")(
      "Run <code>ls {count, plural, one {listing} other {listings}}</code> to list listings.",
    );
    expect(format(rebranded, { count: 1 })).toBe(
      "Run <code>ls listing</code> to list events.",
    );
    expect(format(rebranded, { count: 5 })).toBe(
      "Run <code>ls listings</code> to list events.",
    );
  });

  test("a <code> opener split before its > still protects the example", () => {
    // The argument sits inside the opening tag itself, so the scanner only
    // learns the tag is <code> once its > arrives in a later node.
    const rebranded = buildReplacer("listing|event")(
      'Use <code data-n="{n}">ls listings</code> to list listings.',
    );
    expect(format(rebranded, { n: 2 })).toBe(
      'Use <code data-n="2">ls listings</code> to list events.',
    );
  });

  test("a tag split across three nodes keeps its middle part verbatim", () => {
    // Two arguments inside one href leave a literal that is entirely inside
    // the tag — no < or > of its own — and it must not be rebranded.
    const rebranded = buildReplacer("listing|event")(
      'Open <a href="/listings/{a}/listings/{b}">the listing</a>.',
    );
    expect(format(rebranded, { a: 1, b: 2 })).toBe(
      'Open <a href="/listings/1/listings/2">the event</a>.',
    );
  });

  test("a branch closing a <code> span does not unprotect its siblings", () => {
    // Each branch closes the code span itself, so the copy after the close
    // rebrands inside every branch — including the later ones, which must
    // still open inside the span.
    const rebranded = buildReplacer("listing|event")(
      "<code>{kind, select, ls {ls</code> lists listings} other {ls -a</code> lists all listings}}",
    );
    expect(format(rebranded, { kind: "ls" })).toBe(
      "<code>ls</code> lists events",
    );
    expect(format(rebranded, { kind: "verbose" })).toBe(
      "<code>ls -a</code> lists all events",
    );
  });
});
