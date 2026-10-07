// test-groups: run-alone — these two files sit outside the shared-isolate
// plan so their addition does not reshuffle every other file's group, which
// reshuffles the multi-isolate coverage merge for files like
// fields-of-source.ts (see docs/designing-systems.md#readable-by-the-coverage-merge).
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addedExclusions,
  EXCLUSIONS_PATH,
  exclusionFindings,
  parseExclusionEntries,
} from "#scripts/check-coverage-exclusions/exclusion-ratchet.ts";
import { COVERAGE_EXCLUSIONS } from "#scripts/check-coverage-exclusions/exclusions.ts";

const module = (entries: string[]): string =>
  `// comment\nexport const COVERAGE_EXCLUSIONS = [\n${entries
    .map((entry) => `  "${entry}",`)
    .join("\n")}\n];\n`;

describe("parseExclusionEntries", () => {
  test("reads the quoted entries and skips comments and blanks", () => {
    expect(
      parseExclusionEntries(
        [
          "/** doc */",
          "export const COVERAGE_EXCLUSIONS = [",
          "  // why this file",
          "",
          '  "src/a.ts",',
          '  "src/b.ts",',
          "];",
        ].join("\n"),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("reads an entry that carries an inline comment", () => {
    expect(
      parseExclusionEntries(
        [
          "export const COVERAGE_EXCLUSIONS = [",
          '  "src/a.ts",',
          '  "src/b.ts", // Deno mis-attributes this file once isolates load it',
          "];",
        ].join("\n"),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("reads a final entry written without its trailing comma", () => {
    expect(
      parseExclusionEntries(
        [
          "export const COVERAGE_EXCLUSIONS = [",
          '  "src/a.ts",',
          '  "src/b.ts"',
          "];",
        ].join("\n"),
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("parses the real data module into the array the gate imports", () => {
    const source = Deno.readTextFileSync(EXCLUSIONS_PATH);
    expect(parseExclusionEntries(source)).toEqual([...COVERAGE_EXCLUSIONS]);
  });
});

describe("addedExclusions", () => {
  test("names the entries HEAD adds against the base", () => {
    expect(addedExclusions(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toEqual([
      "src/b.ts",
    ]);
  });

  test("accepts removals and reordering", () => {
    expect(addedExclusions(["src/b.ts"], ["src/a.ts", "src/b.ts"])).toEqual([]);
    expect(
      addedExclusions(["src/b.ts", "src/a.ts"], ["src/a.ts", "src/b.ts"]),
    ).toEqual([]);
  });

  test("treats every entry as added when the base holds none", () => {
    expect(addedExclusions(["src/a.ts"], [])).toEqual(["src/a.ts"]);
  });
});

describe("exclusionFindings", () => {
  test("reports each added entry at its line with the way out", () => {
    const head = module(["src/kept.ts", "src/added.ts"]);
    expect(exclusionFindings(head, ["src/kept.ts"])).toEqual([
      `${EXCLUSIONS_PATH}:4 [added-exclusion]: "src/added.ts" is a new ` +
        "coverage exclusion (the list only shrinks) — restructure the code " +
        "so that the coverage merge reads it. Read " +
        "docs/designing-systems.md#readable-by-the-coverage-merge.",
    ]);
  });

  test("reports nothing when HEAD only removes", () => {
    expect(exclusionFindings(module([]), ["src/gone.ts"])).toEqual([]);
  });

  test("reports an inline-commented added entry at its line", () => {
    const head = [
      "export const COVERAGE_EXCLUSIONS = [",
      '  "src/kept.ts",',
      '  "src/added.ts", // Deno mis-attributes this file once isolates load it',
      "];",
      "",
    ].join("\n");
    expect(exclusionFindings(head, ["src/kept.ts"])).toEqual([
      `${EXCLUSIONS_PATH}:3 [added-exclusion]: "src/added.ts" is a new ` +
        "coverage exclusion (the list only shrinks) — restructure the code " +
        "so that the coverage merge reads it. Read " +
        "docs/designing-systems.md#readable-by-the-coverage-merge.",
    ]);
  });

  test("reports a comma-less added entry at its line", () => {
    const head = [
      "export const COVERAGE_EXCLUSIONS = [",
      '  "src/kept.ts",',
      '  "src/added.ts"',
      "];",
      "",
    ].join("\n");
    expect(exclusionFindings(head, ["src/kept.ts"])).toEqual([
      `${EXCLUSIONS_PATH}:3 [added-exclusion]: "src/added.ts" is a new ` +
        "coverage exclusion (the list only shrinks) — restructure the code " +
        "so that the coverage merge reads it. Read " +
        "docs/designing-systems.md#readable-by-the-coverage-merge.",
    ]);
  });
});
