/** The Markdown text that a write stores. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { markdownSource } from "#shared/markdown-source.ts";

describe("markdownSource", () => {
  test("drops the blank lines before the text and the space after it", () => {
    expect(markdownSource(" \t\n\r\n\n# Title\n\nBody \n\n  ")).toBe(
      "# Title\n\nBody",
    );
  });

  test("keeps the indentation of the first line", () => {
    expect(markdownSource("\n    code();\n")).toBe("    code();");
    expect(markdownSource("  - item")).toBe("  - item");
  });

  test("keeps blank lines inside the text", () => {
    expect(markdownSource("One\n \nTwo")).toBe("One\n \nTwo");
  });

  test("leaves text with no blank lead as it is", () => {
    expect(markdownSource("Text")).toBe("Text");
    expect(markdownSource("")).toBe("");
  });
});
