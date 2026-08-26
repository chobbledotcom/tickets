/**
 * The words a served page really shows, read back off its markup.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";

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
