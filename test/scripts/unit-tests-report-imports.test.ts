import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findMisplacedTests,
  formatMisplacedSection,
  type MisplacedTest,
  parseImportSpecifiers,
  resolveImportToSource,
  resolveTestImports,
} from "../../scripts/unit-tests-report-imports.ts";
import { options } from "./unit-tests-report-fixtures.ts";

/** A small import map covering an exact alias, nested and general directory
 *  aliases, and a non-source alias, so resolution's branches are all exercised. */
const importMap: Record<string, string> = {
  "#fp": "./src/fp.ts",
  "#shared/": "./src/shared/",
  "#shared/db/": "./src/shared/db/",
  "#test-utils/": "./test/test-utils/",
  valibot: "npm:valibot@^1.4.1",
};

/** Build a test-with-imports record. */
const imp = (path: string, imports: string[]) => ({ imports, path });

describe("parseImportSpecifiers", () => {
  test("extracts import and re-export specifiers, including multiline", () => {
    const text = [
      'import { a } from "#fp";',
      "import {",
      "  b,",
      '} from "#shared/db/x.ts";',
      'export { c } from "#shared/y.ts";',
    ].join("\n");
    expect(parseImportSpecifiers(text)).toEqual([
      "#fp",
      "#shared/db/x.ts",
      "#shared/y.ts",
    ]);
  });

  test("ignores side-effect imports with no from clause", () => {
    expect(parseImportSpecifiers('import "./setup.ts";')).toEqual([]);
  });

  test("ignores specifiers that appear inside line or block comments", () => {
    const text = [
      'import { a } from "#fp";',
      '// import { old } from "#shared/gone.ts";',
      "/*",
      ' export { b } from "#shared/also-gone.ts";',
      "*/",
    ].join("\n");
    expect(parseImportSpecifiers(text)).toEqual(["#fp"]);
  });

  test("captures dynamic import() specifiers alongside static ones", () => {
    const text = [
      'import { settings } from "#shared/db/settings.ts";',
      'const mod = await import("#routes/wallet/google.ts");',
    ].join("\n");
    expect(parseImportSpecifiers(text)).toEqual([
      "#shared/db/settings.ts",
      "#routes/wallet/google.ts",
    ]);
  });

  test("skips type-only import and export statements", () => {
    // A type import is erased at runtime, so it doesn't name the code under test.
    const text = [
      'import type { Listing } from "#shared/types.ts";',
      'export type { Foo } from "#shared/foo.ts";',
      'import { real } from "#shared/real.ts";',
    ].join("\n");
    expect(parseImportSpecifiers(text)).toEqual(["#shared/real.ts"]);
  });

  test("returns nothing for text with no imports", () => {
    expect(parseImportSpecifiers("const x = 1;")).toEqual([]);
  });
});

describe("resolveImportToSource", () => {
  test("maps a directory alias's tail onto the source root", () => {
    expect(resolveImportToSource("#shared/email.ts", importMap, "src")).toBe(
      "src/shared/email.ts",
    );
  });

  test("prefers the longest matching alias so a nested dir wins", () => {
    // Both "#shared/" and "#shared/db/" match; the specific one must win.
    expect(
      resolveImportToSource("#shared/db/client.ts", importMap, "src"),
    ).toBe("src/shared/db/client.ts");
  });

  test("maps an exact alias to its whole target", () => {
    expect(resolveImportToSource("#fp", importMap, "src")).toBe("src/fp.ts");
  });

  test("does not treat an exact alias as a directory prefix", () => {
    // "#fp" is exact, so a deeper specifier under it resolves to nothing rather
    // than being glued onto the file target ("src/fp.ts/x.ts").
    expect(resolveImportToSource("#fp/x.ts", importMap, "src")).toBeNull();
  });

  test("the longest directory alias wins even when targets diverge", () => {
    // Nested alias points somewhere unrelated to its parent, so picking the
    // shorter alias would resolve to a different file — only longest-first is
    // correct.
    // Targets are different lengths from their aliases, so ordering by alias
    // length (correct) and by target length (a mutation) give different winners.
    const diverging = { "#a/": "./src/xx/", "#a/b/": "./src/y/" };
    expect(resolveImportToSource("#a/b/c.ts", diverging, "src")).toBe(
      "src/y/c.ts",
    );
  });

  test("returns null for a non-source specifier", () => {
    expect(resolveImportToSource("valibot", importMap, "src")).toBeNull();
    expect(
      resolveImportToSource("#test-utils/db.ts", importMap, "src"),
    ).toBeNull();
    expect(resolveImportToSource("#unknown", importMap, "src")).toBeNull();
  });
});

describe("resolveTestImports", () => {
  test("resolves, de-duplicates, and drops non-source imports", () => {
    const text = [
      'import { a } from "#shared/db/client.ts";',
      'import { b } from "#shared/db/client.ts";', // duplicate
      'import { c } from "#fp";',
      'import { d } from "valibot";', // non-source, dropped
    ].join("\n");
    expect(resolveTestImports(text, importMap, "src")).toEqual([
      "src/shared/db/client.ts",
      "src/fp.ts",
    ]);
  });
});

describe("findMisplacedTests", () => {
  const sources = ["src/shared/email.ts", "src/shared/db/client.ts"];
  const appEntry = "src/features/index.ts";

  test("flags a single-source test that lives off its source's mirror", () => {
    const result = findMisplacedTests(
      [imp("test/lib/mailer.test.ts", ["src/shared/email.ts"])],
      sources,
      options,
      appEntry,
    );
    expect(result).toEqual([
      {
        basenameMatch: false,
        source: "src/shared/email.ts",
        suggestedPrefix: "test/shared/email",
        test: "test/lib/mailer.test.ts",
      },
    ]);
  });

  test("marks a basename match as high confidence", () => {
    const result = findMisplacedTests(
      [imp("test/lib/email.test.ts", ["src/shared/email.ts"])],
      sources,
      options,
      appEntry,
    );
    expect(result[0]).toMatchObject({ basenameMatch: true });
  });

  test("skips a test already sitting at its source's direct mirror", () => {
    expect(
      findMisplacedTests(
        [imp("test/shared/email.test.ts", ["src/shared/email.ts"])],
        sources,
        options,
        appEntry,
      ),
    ).toEqual([]);
  });

  test("skips a test inside its source's mirror directory (suite convention)", () => {
    expect(
      findMisplacedTests(
        [imp("test/shared/email/bounces.test.ts", ["src/shared/email.ts"])],
        sources,
        options,
        appEntry,
      ),
    ).toEqual([]);
  });

  test("skips a test on an exempt tree even if it imports one source", () => {
    // test/e2e/ is exempt in the fixture options, so it never mirrors a source.
    expect(
      findMisplacedTests(
        [imp("test/e2e/flow.test.ts", ["src/shared/email.ts"])],
        sources,
        options,
        appEntry,
      ),
    ).toEqual([]);
  });

  test("skips an integration test that imports the app entry", () => {
    expect(
      findMisplacedTests(
        [imp("test/lib/route.test.ts", [appEntry, "src/shared/email.ts"])],
        sources,
        options,
        appEntry,
      ),
    ).toEqual([]);
  });

  test("skips a test importing more than one source", () => {
    expect(
      findMisplacedTests(
        [
          imp("test/lib/multi.test.ts", [
            "src/shared/email.ts",
            "src/shared/db/client.ts",
          ]),
        ],
        sources,
        options,
        appEntry,
      ),
    ).toEqual([]);
  });

  test("ignores imports of exempt (non-testable) sources", () => {
    // A locale table is exempt, so a test importing only it has no subject.
    const result = findMisplacedTests(
      [imp("test/lib/copy.test.ts", ["src/locales/en/index.ts"])],
      [...sources, "src/locales/en/index.ts"],
      options,
      appEntry,
    );
    expect(result).toEqual([]);
  });

  test("orders basename matches first, then by test path", () => {
    const result = findMisplacedTests(
      [
        imp("test/lib/z-mailer.test.ts", ["src/shared/email.ts"]),
        imp("test/lib/email.test.ts", ["src/shared/email.ts"]),
        imp("test/lib/a-mailer.test.ts", ["src/shared/email.ts"]),
      ],
      sources,
      options,
      appEntry,
    );
    expect(result.map((entry) => entry.test)).toEqual([
      "test/lib/email.test.ts", // basename match, first
      "test/lib/a-mailer.test.ts", // then alphabetical
      "test/lib/z-mailer.test.ts",
    ]);
  });

  test("promotes a match ahead of a non-match given in the wrong order", () => {
    // The non-match is listed first, so only a comparator that sinks it (the
    // basename-mismatch branch) yields the match-first order.
    const result = findMisplacedTests(
      [
        imp("test/lib/mailer.test.ts", ["src/shared/email.ts"]), // non-match
        imp("test/lib/email.test.ts", ["src/shared/email.ts"]), // match
      ],
      sources,
      options,
      appEntry,
    );
    expect(result.map((entry) => entry.test)).toEqual([
      "test/lib/email.test.ts",
      "test/lib/mailer.test.ts",
    ]);
  });
});

describe("formatMisplacedSection", () => {
  const entry = (
    test: string,
    suggestedPrefix: string,
    basenameMatch: boolean,
  ): MisplacedTest => ({
    basenameMatch,
    source: "src/shared/email.ts",
    suggestedPrefix,
    test,
  });

  test("reports a friendly note when nothing is misplaced", () => {
    expect(formatMisplacedSection([], null)).toEqual([
      "  (none — every unit test sits at its source's mirror)",
    ]);
  });

  test("marks basename matches with a tick and names the target and source", () => {
    const lines = formatMisplacedSection(
      [entry("test/lib/email.test.ts", "test/shared/email", true)],
      null,
    );
    expect(lines[0]).toBe(
      "  ✓ test/lib/email.test.ts\n      → test/shared/email  (imports src/shared/email.ts)",
    );
  });

  test("uses a blank marker (not a tick) for a non-matching row", () => {
    const lines = formatMisplacedSection(
      [entry("test/lib/mailer.test.ts", "test/shared/email", false)],
      null,
    );
    // Two indent spaces, then the blank marker space, then a space before path.
    expect(lines[0]).toBe(
      "    test/lib/mailer.test.ts\n      → test/shared/email  (imports src/shared/email.ts)",
    );
  });

  test("truncates to the limit and reports how many more remain", () => {
    const rows = [
      entry("test/lib/a.test.ts", "test/shared/a", false),
      entry("test/lib/b.test.ts", "test/shared/b", false),
      entry("test/lib/c.test.ts", "test/shared/c", false),
    ];
    const lines = formatMisplacedSection(rows, 2);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("  … and 1 more (use --all to list)");
  });

  test("shows every row when under the limit with no truncation note", () => {
    const lines = formatMisplacedSection(
      [entry("test/lib/a.test.ts", "test/shared/a", false)],
      25,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("more");
  });
});
