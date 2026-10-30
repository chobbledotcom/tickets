import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { escapeHtmlApostrophes, escapeXml } from "#shared/xml.ts";

describe("escapeXml", () => {
  test("escapes every XML-special character", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  test("leaves text that holds nothing to escape alone", () => {
    expect(escapeXml("plans-pricing_1+2")).toBe("plans-pricing_1+2");
  });
});

describe("escapeHtmlApostrophes", () => {
  test("extends HTML escaping with the given apostrophe token", () => {
    expect(escapeHtmlApostrophes("&#39;")(`<b>o'brien</b>`)).toBe(
      "&lt;b&gt;o&#39;brien&lt;/b&gt;",
    );
  });

  test("inserts a token holding $ replacement patterns literally", () => {
    expect(escapeHtmlApostrophes("$&x")("o'brien")).toBe("o$&xbrien");
  });
});
