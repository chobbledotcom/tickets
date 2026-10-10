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
    "a backslash at the end of an unterminated string",
    '@import "https://fonts.bunny.net/css\\',
  ],
  ["an unterminated address string", '@import "https://fonts.bunny.net/css'],
  [
    "an unterminated url() at the end",
    "src: url(https://fonts.bunny.net/aleo.woff2",
  ],
  [
    "a url() body that ends in whitespace",
    "src: url(https://fonts.bunny.net/aleo.woff2 ",
  ],
  [
    "a comment after a quoted url() that never closes",
    'src: url("https://fonts.bunny.net/aleo.woff2"/*never',
  ],
  [
    "a comment between the quoted url() string and its close",
    '@import url("https://fonts.bunny.net/css"/**/);',
  ],
  [
    "a comment after a quoted font url()",
    'src: url("https://fonts.bunny.net/aleo.woff2"/*x*/);',
  ],
  [
    "a CRLF after a hex escape",
    '@import "https://fonts.b\\75\r\nnny.net/css";',
  ],
  [
    "a bare carriage return after a hex escape",
    '@import "https://fonts.b\\75\rnny.net/css";',
  ],
  [
    "a form feed line continuation in the host",
    '@import "https://fonts.bu\\\fnny.net/css";',
  ],
  ["a backslash in the path at the end", "src: url(https://fonts.bunny.net/\\"],
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
    "a carriage return and form feed after a backslash",
    '@import "https://fonts.bu\\\r\fnny.net/css";',
  ],
  [
    "an escaped form feed in the url() name",
    "a{background-image:u\\\frl(https://fonts.bunny.net/a)}",
  ],
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
    "a broken url() with no close",
    'background: url("https://fonts.bunny.net/a" junk',
  ],
  [
    "a quote inside an unquoted url()",
    'src: url(https://fonts.bunny.net/a"junk);',
  ],
  [
    "a comment that never closes",
    "/* @import url(https://fonts.bunny.net/css)",
  ],
  [
    "a raw newline inside the address string",
    '@import "https://fonts.bunny.net/css\n";',
  ],
  [
    "a form feed inside the address string",
    'a{background-image:url("https://fonts.bunny.net/a\f")}',
  ],
  [
    "a backslash after the host at the end",
    "a{background-image:url(https://fonts.bunny.net\\",
  ],
  [
    "a non-printable in an unquoted url() at the end",
    "a{background-image:url(https://fonts.bunny.net/a\u0007",
  ],
  [
    "a vertical tab in an unquoted url() at the end",
    "a{background-image:url(https://fonts.bunny.net/a\u000b",
  ],
  [
    "a unit separator in an unquoted url() at the end",
    "a{background-image:url(https://fonts.bunny.net/a\u001f",
  ],
  [
    "a delete control in an unquoted url() at the end",
    "a{background-image:url(https://fonts.bunny.net/a\u007f",
  ],
  [
    "a backslash before a newline in an unquoted url()",
    "src: url(https://fonts.bunny.net/a\\\nb);",
  ],
  [
    "a backslash before a form feed in an unquoted url()",
    "src: url(https://fonts.bunny.net/a\\\fb);",
  ],
  [
    "a backslash before a carriage return in an unquoted url()",
    "src: url(https://fonts.bunny.net/a\\\rb);",
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
