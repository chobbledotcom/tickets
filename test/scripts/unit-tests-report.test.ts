import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildReport,
  countLines,
  DEFAULT_LIMIT,
  DEFAULT_OPTIONS,
  type FileLines,
  formatRatio,
  formatReport,
  isSourcePath,
  isTestableSource,
  isTestPath,
  mirrorPrefix,
  type ReportOptions,
  suggestedTarget,
  testCoversPrefix,
} from "../../scripts/unit-tests-report-lib.ts";

const options: ReportOptions = {
  exemptSourcePrefixes: ["src/locales/"],
  exemptTestPrefixes: ["test/e2e/", "test/setup.ts"],
  srcRoot: "src",
  testRoot: "test",
};

const src = (path: string, lines: number): FileLines => ({ lines, path });
const tst = (path: string, lines: number): FileLines => ({ lines, path });

describe("countLines", () => {
  test("counts non-blank lines only", () => {
    // Multi-character lines distinguish a real newline split from a per-char one.
    expect(countLines("ab\n\n  \ncd\n")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});

describe("isSourcePath", () => {
  test("accepts .ts and .tsx but not declaration or other files", () => {
    expect(isSourcePath("src/a.ts")).toBe(true);
    expect(isSourcePath("src/a.tsx")).toBe(true);
    expect(isSourcePath("src/a.d.ts")).toBe(false);
    expect(isSourcePath("src/a.json")).toBe(false);
  });
});

describe("isTestPath", () => {
  test("accepts only .test.ts and .test.tsx files", () => {
    expect(isTestPath("test/a.test.ts")).toBe(true);
    expect(isTestPath("test/a.test.tsx")).toBe(true);
    expect(isTestPath("test/a.ts")).toBe(false);
    expect(isTestPath("test/helpers.ts")).toBe(false);
  });
});

describe("isTestableSource", () => {
  test("skips declaration files and exempt prefixes, keeps the rest", () => {
    expect(isTestableSource("src/shared/a.ts", options)).toBe(true);
    expect(isTestableSource("src/static.d.ts", options)).toBe(false);
    expect(isTestableSource("src/locales/en/index.ts", options)).toBe(false);
  });
});

describe("mirrorPrefix", () => {
  test("swaps the src root for the test root and drops the extension", () => {
    expect(mirrorPrefix("src/shared/accounting/store.ts", options)).toBe(
      "test/shared/accounting/store",
    );
    expect(mirrorPrefix("src/ui/templates/nav.tsx", options)).toBe(
      "test/ui/templates/nav",
    );
  });
});

describe("testCoversPrefix", () => {
  const prefix = "test/shared/store";
  test("matches the single .test.ts or .test.tsx mirror", () => {
    expect(testCoversPrefix(prefix, "test/shared/store.test.ts")).toBe(true);
    expect(testCoversPrefix(prefix, "test/shared/store.test.tsx")).toBe(true);
  });
  test("matches any file inside a directory named after the source", () => {
    expect(testCoversPrefix(prefix, "test/shared/store/reads.test.ts")).toBe(
      true,
    );
  });
  test("rejects unrelated or sibling-prefixed paths", () => {
    expect(testCoversPrefix(prefix, "test/shared/store-helpers.test.ts")).toBe(
      false,
    );
    expect(testCoversPrefix(prefix, "test/shared/other.test.ts")).toBe(false);
  });
});

describe("buildReport", () => {
  test("pairs sources with mirrored tests and sums their lines", () => {
    const report = buildReport(
      [src("src/shared/a.ts", 100)],
      [tst("test/shared/a.test.ts", 40)],
      options,
    );
    expect(report.totalSources).toBe(1);
    expect(report.testedCount).toBe(1);
    expect(report.untested).toEqual([]);
    expect(report.ranked[0]).toMatchObject({
      path: "src/shared/a.ts",
      ratio: 2.5,
      tested: true,
      testFiles: ["test/shared/a.test.ts"],
      testLines: 40,
    });
  });

  test("gives a source with a single one-line test a finite ratio", () => {
    const report = buildReport(
      [src("src/a.ts", 7)],
      [tst("test/a.test.ts", 1)],
      options,
    );
    expect(report.ranked[0]).toMatchObject({ ratio: 7, tested: true });
  });

  test("groups several test files under a source's directory", () => {
    const report = buildReport(
      [src("src/shared/a.ts", 90)],
      [
        tst("test/shared/a/one.test.ts", 20),
        tst("test/shared/a/two.test.ts", 10),
      ],
      options,
    );
    expect(report.ranked[0]).toMatchObject({
      ratio: 3,
      testFiles: ["test/shared/a/one.test.ts", "test/shared/a/two.test.ts"],
      testLines: 30,
    });
  });

  test("marks a source with no mirror as untested with an infinite ratio", () => {
    const report = buildReport([src("src/shared/a.ts", 50)], [], options);
    expect(report.testedCount).toBe(0);
    expect(report.untested[0]).toMatchObject({
      ratio: Number.POSITIVE_INFINITY,
      tested: false,
      testLines: 0,
    });
    expect(report.ranked).toEqual([]);
  });

  test("drops exempt sources before counting", () => {
    const report = buildReport(
      [src("src/locales/en/index.ts", 10), src("src/static.d.ts", 3)],
      [],
      options,
    );
    expect(report.totalSources).toBe(0);
  });

  test("orders untested biggest-first and ranked thinnest-first", () => {
    const report = buildReport(
      [
        src("src/small.ts", 10),
        src("src/big.ts", 200),
        src("src/thin.ts", 100),
        src("src/thick.ts", 100),
      ],
      [tst("test/thin.test.ts", 5), tst("test/thick.test.ts", 90)],
      options,
    );
    expect(report.untested.map((s) => s.path)).toEqual([
      "src/big.ts",
      "src/small.ts",
    ]);
    expect(report.ranked.map((s) => s.path)).toEqual([
      "src/thin.ts",
      "src/thick.ts",
    ]);
  });

  test("breaks an untested tie on file path, and a ratio tie on size then path", () => {
    const report = buildReport(
      [
        // Same size, both untested -> tie broken by path (b before z).
        src("src/z.ts", 100),
        src("src/b.ts", 100),
        // Same ratio (4.0); bigger source ranks first.
        src("src/big-ratio.ts", 200),
        src("src/small-ratio.ts", 20),
        // Identical ratio (2.0) and size -> tie broken by path (m before n).
        src("src/n.ts", 40),
        src("src/m.ts", 40),
      ],
      [
        tst("test/big-ratio.test.ts", 50),
        tst("test/small-ratio.test.ts", 5),
        tst("test/n.test.ts", 20),
        tst("test/m.test.ts", 20),
      ],
      options,
    );
    expect(report.untested.map((s) => s.path)).toEqual([
      "src/b.ts",
      "src/z.ts",
    ]);
    expect(report.ranked.map((s) => s.path)).toEqual([
      "src/big-ratio.ts",
      "src/small-ratio.ts",
      "src/m.ts",
      "src/n.ts",
    ]);
  });

  test("reports test files that mirror no source, sorted, minus exempt trees", () => {
    const report = buildReport(
      [src("src/shared/a.ts", 10)],
      [
        tst("test/shared/a.test.ts", 5),
        // Two orphans, given out of order, so the sort is exercised.
        tst("test/shared/zeta.test.ts", 5),
        tst("test/shared/ghost.test.ts", 5),
        tst("test/e2e/flow.test.ts", 5),
        tst("test/setup.ts", 5),
      ],
      options,
    );
    expect(report.orphanTests).toEqual([
      "test/shared/ghost.test.ts",
      "test/shared/zeta.test.ts",
    ]);
  });
});

describe("suggestedTarget", () => {
  test("prefers the largest untested source", () => {
    const report = buildReport(
      [src("src/big.ts", 200), src("src/tested.ts", 100)],
      [tst("test/tested.test.ts", 10)],
      options,
    );
    expect(suggestedTarget(report)?.path).toBe("src/big.ts");
  });

  test("falls back to the thinnest-tested source when none are untested", () => {
    const report = buildReport(
      [src("src/thin.ts", 100), src("src/thick.ts", 100)],
      [tst("test/thin.test.ts", 5), tst("test/thick.test.ts", 90)],
      options,
    );
    expect(suggestedTarget(report)?.path).toBe("src/thin.ts");
  });

  test("returns null when there are no testable sources", () => {
    expect(suggestedTarget(buildReport([], [], options))).toBeNull();
  });
});

describe("formatRatio", () => {
  test("shows infinity as a symbol and finite ratios to two decimals", () => {
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatRatio(2.5)).toBe("2.50");
  });
});

describe("formatReport", () => {
  // Exact-output assertions: the aligned columns, padding and labels are part
  // of the report's contract, so every character is pinned down here.
  test("renders the full report with an untested target, a ranked row and an orphan", () => {
    const report = buildReport(
      [src("src/big.ts", 200), src("src/thin.ts", 100)],
      [tst("test/thin.test.ts", 5), tst("test/ghost.test.ts", 5)],
      options,
    );
    expect(formatReport(report, null)).toEqual([
      "Unit-test coverage report",
      "=========================",
      "Source files needing a test: 2",
      "  with a mirrored test:      1 (50.0%)",
      "  untested:                  1",
      "Orphan test files (mirror no source): 1",
      "",
      "👉 Suggested next target: src/big.ts (untested, 200 lines)",
      "",
      "Untested source files (largest first):",
      "    200  src/big.ts",
      "",
      "Thinnest-tested source files (highest src:test ratio first):",
      "   ratio    src   test  file",
      "   20.00    100      5  src/thin.ts",
      "",
      "Orphan test files (not at any source's mirror path):",
      "  test/ghost.test.ts",
    ]);
  });

  test("caps each list at the limit and notes how many rows were hidden", () => {
    const report = buildReport(
      [
        src("src/u1.ts", 200),
        src("src/u2.ts", 100),
        src("src/t1.ts", 60),
        src("src/t2.ts", 30),
      ],
      [
        tst("test/t1.test.ts", 5),
        tst("test/t2.test.ts", 5),
        tst("test/o1.test.ts", 5),
        tst("test/o2.test.ts", 5),
      ],
      options,
    );
    expect(formatReport(report, 1)).toEqual([
      "Unit-test coverage report",
      "=========================",
      "Source files needing a test: 4",
      "  with a mirrored test:      2 (50.0%)",
      "  untested:                  2",
      "Orphan test files (mirror no source): 2",
      "",
      "👉 Suggested next target: src/u1.ts (untested, 200 lines)",
      "",
      "Untested source files (largest first):",
      "    200  src/u1.ts",
      "  … and 1 more (use --all to list)",
      "",
      "Thinnest-tested source files (highest src:test ratio first):",
      "   ratio    src   test  file",
      "   12.00     60      5  src/t1.ts",
      "  … and 1 more (use --all to list)",
      "",
      "Orphan test files (not at any source's mirror path):",
      "  test/o1.test.ts",
      "  … and 1 more (use --all to list)",
    ]);
  });

  test("shows placeholders and a do-nothing target for an empty tree", () => {
    expect(formatReport(buildReport([], [], options), null)).toEqual([
      "Unit-test coverage report",
      "=========================",
      "Source files needing a test: 0",
      "  with a mirrored test:      0 (0.0%)",
      "  untested:                  0",
      "Orphan test files (mirror no source): 0",
      "",
      "👉 Nothing to do — no testable sources found.",
      "",
      "Untested source files (largest first):",
      "  (none — every source has a test)",
      "",
      "Thinnest-tested source files (highest src:test ratio first):",
      "  (none)",
      "",
      "Orphan test files (not at any source's mirror path):",
      "  (none)",
    ]);
  });

  test("names a tested target with its ratio when nothing is untested", () => {
    const report = buildReport(
      [src("src/a.ts", 10)],
      [tst("test/a.test.ts", 10)],
      options,
    );
    expect(formatReport(report, null)).toEqual([
      "Unit-test coverage report",
      "=========================",
      "Source files needing a test: 1",
      "  with a mirrored test:      1 (100.0%)",
      "  untested:                  0",
      "Orphan test files (mirror no source): 0",
      "",
      "👉 Suggested next target: src/a.ts (ratio 1.00, 10 src / 10 test lines)",
      "",
      "Untested source files (largest first):",
      "  (none — every source has a test)",
      "",
      "Thinnest-tested source files (highest src:test ratio first):",
      "   ratio    src   test  file",
      "    1.00     10     10  src/a.ts",
      "",
      "Orphan test files (not at any source's mirror path):",
      "  (none)",
    ]);
  });
});

describe("DEFAULT_OPTIONS and DEFAULT_LIMIT", () => {
  test("target the real roots, exempt lists, and default row cap", () => {
    expect(DEFAULT_LIMIT).toBe(25);
    expect(DEFAULT_OPTIONS.srcRoot).toBe("src");
    expect(DEFAULT_OPTIONS.testRoot).toBe("test");
    expect(DEFAULT_OPTIONS.exemptSourcePrefixes).toEqual(["src/locales/"]);
    expect(DEFAULT_OPTIONS.exemptTestPrefixes).toEqual([
      "test/e2e/",
      "test/integration/",
      "test/scripts/",
      "test/test-utils/",
      "test/setup.ts",
      "test/test-utils.ts",
    ]);
  });
});
