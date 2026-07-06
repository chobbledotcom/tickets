import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildReport,
  formatRatio,
  formatReport,
} from "../../scripts/unit-tests-report-lib.ts";
import { options, src, tst } from "./unit-tests-report-fixtures.ts";

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
