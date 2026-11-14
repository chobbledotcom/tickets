/** The Markdown text that a write stores. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { markdownSource } from "#shared/markdown-source.ts";

const cases: [name: string, pairs: [input: string, stored: string][]][] = [
  [
    "drops the blank lines before the text and the space after it",
    [[" \t\n\r\n\n# Title\n\nBody \n\n  ", "# Title\n\nBody"]],
  ],
  [
    "keeps the indentation of the first line",
    [
      ["\n    code();\n", "    code();"],
      ["  - item", "  - item"],
    ],
  ],
  ["keeps blank lines inside the text", [["One\n \nTwo", "One\n \nTwo"]]],
  [
    "leaves text with no blank lead as it is",
    [
      ["Text", "Text"],
      ["", ""],
    ],
  ],
];

describe("markdownSource", () => {
  for (const [name, pairs] of cases) {
    test(name, () => {
      for (const [input, stored] of pairs) {
        expect(markdownSource(input)).toBe(stored);
      }
    });
  }
});
