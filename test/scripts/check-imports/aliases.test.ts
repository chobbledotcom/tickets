import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type Alias,
  bestSpelling,
  formatIssue,
  resolveSpecifier,
} from "#scripts/check-imports/rules.ts";
import { ALIASES } from "./fixtures.ts";

/** One case for either alias reader: the test's name, the alias table it is
 *  given, the specifier or path, and the answer it must reach. */
type SpellingCase = readonly [
  name: string,
  aliases: Alias[],
  given: string,
  expected: string | null,
];

/** A test per case, so every spelling rule keeps its own name. */
const expectSpellings = (
  read: (aliases: Alias[], given: string) => string | null,
  cases: readonly SpellingCase[],
): void => {
  for (const [name, aliases, given, expected] of cases) {
    test(name, () => {
      expect(read(aliases, given)).toBe(expected);
    });
  }
};

/** Two aliases where the longer name also covers a folder of its own. */
const nestedAliases: Alias[] = [
  { name: "#a/", target: "./one/" },
  { name: "#a/b/", target: "./two/" },
];

/** Two aliases of equal length that reach the same folder. */
const tiedAliases: Alias[] = [
  { name: "#bb/", target: "./x/" },
  { name: "#aa/", target: "./x/" },
];

describe("resolveSpecifier", () => {
  expectSpellings(resolveSpecifier, [
    [
      "reads a folder alias as the folder plus the rest",
      ALIASES,
      "#db/client.ts",
      "./src/shared/db/client.ts",
    ],
    [
      "reads a whole-module alias as that module",
      ALIASES,
      "#types",
      "./src/shared/types.ts",
    ],
    [
      "lets the longest matching alias win, as the runtime does",
      nestedAliases,
      "#a/b/c.ts",
      "./two/c.ts",
    ],
    [
      "returns null for a specifier no alias covers",
      ALIASES,
      "#nope/x.ts",
      null,
    ],
    [
      "does not read a whole-module alias as a folder",
      ALIASES,
      "#types/extra.ts",
      null,
    ],
  ]);
});

describe("bestSpelling", () => {
  expectSpellings(bestSpelling, [
    [
      "prefers the shortest alias that reaches the file",
      ALIASES,
      "./src/shared/db/client.ts",
      "#db/client.ts",
    ],
    [
      "prefers a whole-module alias over spelling out the folder",
      ALIASES,
      "./src/shared/types.ts",
      "#types",
    ],
    [
      "never proposes an alias that omits the file extension",
      ALIASES,
      "./src/shared/jsx/jsx-runtime.ts",
      "#shared/jsx/jsx-runtime.ts",
    ],
    [
      "breaks a tie alphabetically so one file gets one answer",
      tiedAliases,
      "./x/f.ts",
      "#aa/f.ts",
    ],
    [
      "keeps the shortest alias over an earlier longer one",
      [
        { name: "#z/", target: "./x/" },
        { name: "#aaa/", target: "./x/" },
      ],
      "./x/f.ts",
      "#z/f.ts",
    ],
    [
      "returns null when no alias reaches the file",
      ALIASES,
      "./elsewhere/f.ts",
      null,
    ],
  ]);
});

describe("formatIssue", () => {
  test("names the file and line before the message", () => {
    expect(formatIssue("src/a.ts", { line: 7, message: "went wrong" })).toBe(
      "src/a.ts:7 went wrong",
    );
  });
});
