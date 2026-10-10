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
  [
    "a quoted url() with spaces around it",
    '@import url( "https://fonts.bunny.net/css?family=aleo" );',
  ],
  [
    "escaped letters in the host",
    '@import "https://fonts.b\\75nny.net/css?family=aleo";',
  ],
  [
    "an escaped url function name",
    "@import u\\72l(https://fonts.bunny.net/css);",
  ],
  [
    "a hex escape with its one space",
    "@import url(https://fonts.b\\75 nny.net/css);",
  ],
  [
    "an escaped character in the address",
    "@import url(https://fonts.bunny.net/css\\?family=aleo);",
  ],
  [
    "a line continuation in the host",
    '@import "https://fonts.bu\\\nnny.net/css";',
  ],
  [
    "a carriage-return line continuation in the host",
    '@import "https://fonts.bu\\\r\nnny.net/css";',
  ],
  [
    "a bare carriage-return continuation in the host",
    '@import "https://fonts.bu\\\rnny.net/css";',
  ],
  [
    "a scheme-relative address",
    "@import url(//fonts.bunny.net/css?family=aleo);",
  ],
  ["a scheme-relative @import string", '@import "//fonts.bunny.net/css";'],
  [
    "a division slash that is not a comment",
    "a { font: 12px/1.5 Arial; src: url(https://fonts.bunny.net/aleo.woff2); }",
  ],
  [
    "a second import whose string names the host",
    '@import url("a"); @import "https://fonts.bunny.net/css";',
  ],
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
  ["a non-default port", "@import url(https://fonts.bunny.net:8443/css);"],
  ["a relative url", "src: url(/fonts/aleo.woff2);"],
  [
    "url text inside a content string",
    'body::after { content: "url(https://fonts.bunny.net/css)"; }',
  ],
  [
    "comment text inside the address string",
    '@import "https:/*x*///fonts.bunny.net/css";',
  ],
  [
    "a second string in the import prelude",
    '@import "a" "https://fonts.bunny.net/x";',
  ],
  [
    "a string after a url() in the import prelude",
    '@import url(a) "https://fonts.bunny.net/x";',
  ],
  [
    "an out-of-range escape in the host",
    "src: url(https://fonts.b\\ffffffnny.net/x);",
  ],
  [
    "comment text inside an unquoted url()",
    "url(/*x*/https://fonts.bunny.net/a)",
  ],
  [
    "a backslash at the end of an unterminated string",
    '@import "https://fonts.bunny.net/css\\',
  ],
  [
    "a broken url() with no close",
    'background: url("https://fonts.bunny.net/a" junk',
  ],
  ["an unterminated address string", '@import "https://fonts.bunny.net/css'],
  [
    "an unterminated url() at the end",
    "src: url(https://fonts.bunny.net/aleo.woff2",
  ],
  [
    "a quote inside an unquoted url()",
    'src: url(https://fonts.bunny.net/a"junk);',
  ],
  [
    "a comment that never closes",
    "/* @import url(https://fonts.bunny.net/css)",
  ],
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

  test("does not throw on a large stylesheet that never names the host", () => {
    const css = "body { color: red; }\n/* pad */\n".repeat(2000);
    expect(cssUsesBunnyFonts(css)).toBe(false);
  });
});
