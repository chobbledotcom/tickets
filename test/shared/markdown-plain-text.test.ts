import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { markdownToPlainText } from "#shared/markdown-plain-text.ts";

describe("markdownToPlainText", () => {
  test("removes a picture and trims the text", () => {
    expect(markdownToPlainText("Bath bombs and shizz ![nerves](img#4)")).toBe(
      "Bath bombs and shizz",
    );
  });

  test("removes a reference-style picture and its definition", () => {
    expect(markdownToPlainText("Hi ![A][5]\n\n[5]: img#5")).toBe("Hi");
  });

  test("gives an empty string for a description that is only a picture", () => {
    expect(markdownToPlainText("![A](img#5)")).toBe("");
  });

  test("turns a link into its words", () => {
    expect(markdownToPlainText("Read [the rules](https://x.test/r) now")).toBe(
      "Read the rules now",
    );
  });

  test("turns a reference-style link into its words", () => {
    expect(markdownToPlainText("[site][1]\n\n[1]: https://x.test")).toBe(
      "site",
    );
  });

  test("keeps the words of a picture inside a link's text out", () => {
    expect(markdownToPlainText("[go ![A](img#5)](https://x.test)")).toBe("go");
  });

  test("removes the hash marks of a heading", () => {
    expect(markdownToPlainText("## Doors\n\nOpen at 7")).toBe("Doors Open at 7");
  });

  test("turns line breaks into single spaces", () => {
    expect(markdownToPlainText("one\ntwo  \nthree\n\n\nfour")).toBe(
      "one two three four",
    );
  });

  test("joins list items and quoted lines with a space", () => {
    expect(markdownToPlainText("- red\n- blue\n\n> quoted\n> text")).toBe(
      "red blue quoted text",
    );
  });

  test("removes bold, italic, strike and code marks", () => {
    expect(markdownToPlainText("**a** *b* ~~c~~ `d`")).toBe("a b c d");
  });

  test("keeps the text of a code block", () => {
    expect(markdownToPlainText("```\nlet x\n```")).toBe("let x");
  });

  test("keeps the cells of a table", () => {
    expect(markdownToPlainText("| a | b |\n|---|---|\n| c | d |")).toBe(
      "a b c d",
    );
  });

  test("gives the character of a backslash escape", () => {
    expect(markdownToPlainText("1\\. not a list")).toBe("1. not a list");
  });

  test("drops a rule and raw HTML", () => {
    expect(markdownToPlainText("a\n\n---\n\n<div>x</div>\n\nb")).toBe("a b");
  });

  test("closes the gap that a removed picture leaves before punctuation", () => {
    expect(markdownToPlainText("Come along ![A](img#5), please!")).toBe(
      "Come along, please!",
    );
  });

  test("gives an empty string for an empty text", () => {
    expect(markdownToPlainText("")).toBe("");
  });
});
