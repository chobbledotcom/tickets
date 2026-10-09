import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { detectThenUsage } from "#test/scripts/code-quality/detectors.ts";
import { detectRelativeImport } from "#test/scripts/code-quality/relative-import.ts";
import {
  collectFileViolations,
  collectLineViolations,
  getRelativePath,
  REPO_ROOT,
  SRC_DIR,
} from "#test/scripts/code-quality/scan-context.ts";

/**
 * The live-tree assertions in test/integration/code-quality.test.ts pass the
 * real trees through the scan-context walkers. Fixtures here re-run rules
 * through the same walkers and assert the exact violation strings, so the
 * walkers hand each detector the right path and contents and skip the
 * code-quality folder's own files.
 */
describe("code-quality scan context", () => {
  const fixture = join(SRC_DIR, "scan-context-fixture.ts");
  const thenLine = "const x = Promise.resolve(1).then(() => 2);";

  test("collectLineViolations runs a line detector over every file line", () => {
    const contents = new Map([[fixture, `const fine = 1;\n${thenLine}\n`]]);
    expect(collectLineViolations([fixture], contents, detectThenUsage)).toEqual(
      [
        `src/scan-context-fixture.ts:2: ${thenLine}... (use async/await instead)`,
      ],
    );
  });

  test("collectLineViolations skips the code-quality folder's own files", () => {
    const own = join(REPO_ROOT, "test/scripts/code-quality/fixture.ts");
    const contents = new Map([[own, `${thenLine}\n`]]);
    expect(collectLineViolations([own], contents, detectThenUsage)).toEqual([]);
  });

  test("collectFileViolations runs a whole-file detector and reports repo-relative paths", () => {
    const contents = new Map([[fixture, 'import "../sibling.ts";\n']]);
    const violations = collectFileViolations(
      [fixture],
      contents,
      detectRelativeImport,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/scan-context-fixture.ts:1");
    expect(violations[0]).toContain(
      "(use a # alias instead of a ../ relative import)",
    );
  });

  test("getRelativePath names a file relative to src/", () => {
    expect(getRelativePath(join(SRC_DIR, "shared/example.ts"))).toBe(
      "shared/example.ts",
    );
  });
});
