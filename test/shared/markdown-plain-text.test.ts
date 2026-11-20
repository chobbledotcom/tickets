import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { markdownToPlainText } from "#shared/markdown-plain-text.ts";

type Case = { markdown: string; name: string; plain: string };

/* jscpd:ignore-start -- static data, not code */
const cases: readonly Case[] = [
  {
    markdown: "Bath bombs and shizz ![nerves](img#4)",
    name: "removes a picture and trims the text",
    plain: "Bath bombs and shizz",
  },
  {
    markdown: "Hi ![A][5]\n\n[5]: img#5",
    name: "removes a reference-style picture and its definition",
    plain: "Hi",
  },
  {
    markdown: "![A](img#5)",
    name: "gives an empty string for a description that is only a picture",
    plain: "",
  },
  {
    markdown: "Read [the rules](https://x.test/r) now",
    name: "turns a link into its words",
    plain: "Read the rules now",
  },
  {
    markdown: "[site][1]\n\n[1]: https://x.test",
    name: "turns a reference-style link into its words",
    plain: "site",
  },
  {
    markdown: "[go ![A](img#5)](https://x.test)",
    name: "keeps a picture inside a link's text out",
    plain: "go",
  },
  {
    markdown: "## Doors\n\nOpen at 7",
    name: "removes the hash marks of a heading",
    plain: "Doors Open at 7",
  },
  {
    markdown: "one\ntwo  \nthree\n\n\nfour",
    name: "turns line breaks into single spaces",
    plain: "one two three four",
  },
  {
    markdown: "- red\n- blue\n\n> quoted\n> text",
    name: "joins list items and quoted lines with a space",
    plain: "red blue quoted text",
  },
  {
    markdown: "**a** *b* ~~c~~ `d`",
    name: "removes bold, italic, strike and code marks",
    plain: "a b c d",
  },
  {
    markdown: "```\nlet x\n```",
    name: "keeps the text of a code block",
    plain: "let x",
  },
  {
    markdown: "| a | b |\n|---|---|\n| c | d |",
    name: "keeps the cells of a table",
    plain: "a b c d",
  },
  {
    markdown: "1\\. not a list",
    name: "gives the character of a backslash escape",
    plain: "1. not a list",
  },
  {
    markdown: "a\n\n---\n\n<div>x</div>\n\nb",
    name: "drops a rule and raw HTML",
    plain: "a b",
  },
  {
    markdown: "Come along ![A](img#5), please!",
    name: "closes the gap that a removed picture leaves before punctuation",
    plain: "Come along, please!",
  },
  { markdown: "", name: "gives an empty string for an empty text", plain: "" },
];
/* jscpd:ignore-end */

describe("markdownToPlainText", () => {
  for (const { markdown, name, plain } of cases) {
    test(name, () => {
      expect(markdownToPlainText(markdown)).toBe(plain);
    });
  }
});
