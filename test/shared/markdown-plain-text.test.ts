import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { markdownToPlainText } from "#shared/markdown-plain-text.ts";

type Case = { name: string; markdown: string; plain: string };

/* jscpd:ignore-start -- static data, not code */
const cases: readonly Case[] = [
  {
    name: "removes a picture and trims the text",
    markdown: "Bath bombs and shizz ![nerves](img#4)",
    plain: "Bath bombs and shizz",
  },
  {
    name: "removes a reference-style picture and its definition",
    markdown: "Hi ![A][5]\n\n[5]: img#5",
    plain: "Hi",
  },
  {
    name: "gives an empty string for a description that is only a picture",
    markdown: "![A](img#5)",
    plain: "",
  },
  {
    name: "turns a link into its words",
    markdown: "Read [the rules](https://x.test/r) now",
    plain: "Read the rules now",
  },
  {
    name: "turns a reference-style link into its words",
    markdown: "[site][1]\n\n[1]: https://x.test",
    plain: "site",
  },
  {
    name: "keeps a picture inside a link's text out",
    markdown: "[go ![A](img#5)](https://x.test)",
    plain: "go",
  },
  {
    name: "removes the hash marks of a heading",
    markdown: "## Doors\n\nOpen at 7",
    plain: "Doors Open at 7",
  },
  {
    name: "turns line breaks into single spaces",
    markdown: "one\ntwo  \nthree\n\n\nfour",
    plain: "one two three four",
  },
  {
    name: "joins list items and quoted lines with a space",
    markdown: "- red\n- blue\n\n> quoted\n> text",
    plain: "red blue quoted text",
  },
  {
    name: "removes bold, italic, strike and code marks",
    markdown: "**a** *b* ~~c~~ `d`",
    plain: "a b c d",
  },
  {
    name: "keeps the text of a code block",
    markdown: "```\nlet x\n```",
    plain: "let x",
  },
  {
    name: "keeps the cells of a table",
    markdown: "| a | b |\n|---|---|\n| c | d |",
    plain: "a b c d",
  },
  {
    name: "gives the character of a backslash escape",
    markdown: "1\\. not a list",
    plain: "1. not a list",
  },
  {
    name: "drops a rule and raw HTML",
    markdown: "a\n\n---\n\n<div>x</div>\n\nb",
    plain: "a b",
  },
  {
    name: "closes the gap that a removed picture leaves before punctuation",
    markdown: "Come along ![A](img#5), please!",
    plain: "Come along, please!",
  },
  { name: "gives an empty string for an empty text", markdown: "", plain: "" },
];
/* jscpd:ignore-end */

describe("markdownToPlainText", () => {
  for (const { name, markdown, plain } of cases) {
    test(name, () => {
      expect(markdownToPlainText(markdown)).toBe(plain);
    });
  }
});
