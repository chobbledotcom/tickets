/**
 * The words a served page really shows, read back off its markup.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  decodeEntities,
  findAllNavLinks,
  regionOutOf,
} from "#test-utils/test-browser/parsing.ts";

describe("decodeEntities", () => {
  test("gives the character a reader sees for each entity", () => {
    expect(
      decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"),
    ).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities("&larr; &mdash; &nbsp; &times;")).toBe("← —   ×");
  });

  test("decodes in one pass, so a doubly escaped page reads as it renders", () => {
    // `&amp;times;` is the literal text "&times;", which a browser shows as it
    // is. Decoding one kind of entity at a time would turn it into "×", and a
    // page that escaped its markup twice would read as if it were right.
    expect(decodeEntities("Kit &amp;times;3")).toBe("Kit &times;3");
    expect(decodeEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  test("leaves text carrying no entity alone", () => {
    expect(decodeEntities("Pottery x 3")).toBe("Pottery x 3");
  });
});

describe("findAllNavLinks", () => {
  const MENU =
    '<nav aria-label="Site menu"><ul><li><a href="/page/how-to-find-us">Directions</a></li></ul></nav>';

  test("reads the links a navigation bar offers", () => {
    expect(findAllNavLinks(MENU)).toEqual([
      { href: "/page/how-to-find-us", text: "Directions" },
    ]);
  });

  test("reads every bar, and a link however its anchor is written", () => {
    expect(
      findAllNavLinks(
        `${MENU}<nav aria-label="Site menu"><a class="row" href="/news">News</a></nav>`,
      ),
    ).toEqual([
      { href: "/page/how-to-find-us", text: "Directions" },
      { href: "/news", text: "News" },
    ]);
  });

  test("leaves out links outside the bars", () => {
    expect(
      findAllNavLinks(
        '<p>Read <a href="/page/how-to-find-us">the directions</a>.</p>',
      ),
    ).toEqual([]);
  });
});

describe("regionOutOf", () => {
  test("slices from the opening marker to the close", () => {
    expect(
      regionOutOf(
        '<div class="a">middle</div>',
        '<div class="a">',
        "</div>",
        "a",
      ),
    ).toBe('<div class="a">middle');
  });

  test("refuses a page that renders no such region", () => {
    expect(() =>
      regionOutOf("nothing here", "<main>", "</main>", "main"),
    ).toThrow("the page renders no main");
  });

  test("refuses a region that never closes", () => {
    expect(() =>
      regionOutOf(
        '<div class="a">never closed',
        '<div class="a">',
        "</div>",
        "a",
      ),
    ).toThrow("the page renders no a");
  });
});
