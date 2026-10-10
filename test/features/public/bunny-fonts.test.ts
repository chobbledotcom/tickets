import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BUNNY_FONTS_ORIGIN,
  cssUsesBunnyFonts,
} from "#routes/public/bunny-fonts.ts";

const MATCHES: [string, string][] = [
  ["an @import url()", "@import url(https://fonts.bunny.net/css?family=aleo);"],
  [
    "a quoted @import stylesheet string",
    '@import "https://fonts.bunny.net/css?family=aleo";',
  ],
  [
    "a single-quoted @import stylesheet string",
    "@import 'https://fonts.bunny.net/css?family=aleo';",
  ],
  [
    "a font file url()",
    'src: url(https://fonts.bunny.net/aleo.woff2) format("woff2");',
  ],
  ["a quoted url()", 'background: url("https://fonts.bunny.net/aleo.woff2");'],
  [
    "a single-quoted url()",
    "background: url('https://fonts.bunny.net/aleo.woff2');",
  ],
  ["any letter case", "@IMPORT URL(HTTPS://FONTS.BUNNY.NET/CSS);"],
  ["spaces inside url()", "src: url( https://fonts.bunny.net/aleo.woff2 );"],
];

const MISSES: [string, string][] = [
  [
    "an address inside a comment",
    "/* @import url(https://fonts.bunny.net/css); */",
  ],
  ["another host", "@import url(https://fonts.example.com/css);"],
  ["a lookalike subdomain", "@import url(https://evilfonts.bunny.net/css);"],
  [
    "a lookalike host suffix",
    "@import url(https://fonts.bunny.net.evil.com/css);",
  ],
  ["http instead of https", "@import url(http://fonts.bunny.net/css);"],
  ["a protocol-relative url", "@import url(//fonts.bunny.net/css);"],
  ["a non-default port", "@import url(https://fonts.bunny.net:8443/css);"],
  ["a relative url", "src: url(/fonts/aleo.woff2);"],
  ["the host in a plain string", 'content: "fonts.bunny.net";'],
  ["an unparseable url", "src: url(https://bad host/aleo.woff2);"],
  ["empty css", ""],
];

describe("cssUsesBunnyFonts", () => {
  test("pins the one origin the policy may name", () => {
    expect(BUNNY_FONTS_ORIGIN).toBe("https://fonts.bunny.net");
  });

  for (const [why, css] of MATCHES) {
    test(`matches ${why}`, () => {
      expect(cssUsesBunnyFonts(css)).toBe(true);
    });
  }

  for (const [why, css] of MISSES) {
    test(`does not match ${why}`, () => {
      expect(cssUsesBunnyFonts(css)).toBe(false);
    });
  }

  test("counts a bunny address a comment hides inside url()", () => {
    // The strip removes comment text wholesale, so it can reveal an address
    // inside a token. It can only reveal an origin the operator named.
    expect(cssUsesBunnyFonts("url(/*x*/https://fonts.bunny.net/a)")).toBe(true);
  });

  test("does not throw on a large stylesheet that never names the host", () => {
    const css = "body { color: red; }\n/* pad */\n".repeat(2000);
    expect(cssUsesBunnyFonts(css)).toBe(false);
  });
});
