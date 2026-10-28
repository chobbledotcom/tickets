import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  annotationLines,
  findingKey,
  findingKeySet,
  formatGateFinding,
  partitionFindings,
} from "#scripts/check-test-quality/gate.ts";
import type { TestQualityFinding } from "#scripts/test-quality-audit-model.ts";

const finding = (
  path: string,
  message: string,
  line = 1,
  column = 7,
): TestQualityFinding => ({ column, line, message, path });

const PRESENCE =
  "presence-only assertion; prefer checking the value, shape, or invariant";

describe("findingKey", () => {
  test("identifies a finding by path and message", () => {
    expect(findingKey(finding("test/a.test.ts", PRESENCE))).toBe(
      `test/a.test.ts\u0000${PRESENCE}`,
    );
  });

  test("ignores the line so a moved finding stays the same finding", () => {
    expect(findingKey(finding("test/a.test.ts", PRESENCE, 5))).toBe(
      findingKey(finding("test/a.test.ts", PRESENCE, 12)),
    );
  });
});

describe("findingKeySet", () => {
  test("deduplicates the identities a list holds", () => {
    const set = findingKeySet([
      finding("test/a.test.ts", PRESENCE),
      finding("test/a.test.ts", PRESENCE, 9),
      finding(
        "test/a.test.ts",
        "truthiness assertion; prefer an exact value or contract-specific matcher",
      ),
    ]);
    expect(set.size).toBe(2);
  });
});

describe("partitionFindings", () => {
  test("reports nothing added when head and base hold the same findings", () => {
    const head = [finding("test/a.test.ts", PRESENCE)];
    expect(partitionFindings(head, head)).toEqual({
      added: [],
      existing: [finding("test/a.test.ts", PRESENCE)],
    });
  });

  test("treats a moved finding as existing, not added", () => {
    expect(
      partitionFindings(
        [finding("test/a.test.ts", PRESENCE, 20)],
        [finding("test/a.test.ts", PRESENCE, 3)],
      ),
    ).toEqual({
      added: [],
      existing: [finding("test/a.test.ts", PRESENCE, 20)],
    });
  });

  test("splits added from existing findings", () => {
    const added = finding(
      "test/a.test.ts",
      "truthiness assertion; prefer an exact value or contract-specific matcher",
    );
    expect(
      partitionFindings(
        [finding("test/a.test.ts", PRESENCE), added],
        [finding("test/a.test.ts", PRESENCE)],
      ),
    ).toEqual({
      added: [added],
      existing: [finding("test/a.test.ts", PRESENCE)],
    });
  });

  test("treats every finding as added when the base holds none", () => {
    expect(
      partitionFindings([finding("test/a.test.ts", PRESENCE)], []),
    ).toEqual({
      added: [finding("test/a.test.ts", PRESENCE)],
      existing: [],
    });
  });

  test("keeps one path's findings independent of another path's", () => {
    expect(
      partitionFindings(
        [finding("test/a.test.ts", PRESENCE)],
        [finding("test/b.test.ts", PRESENCE)],
      ),
    ).toEqual({
      added: [finding("test/a.test.ts", PRESENCE)],
      existing: [],
    });
  });
});

describe("formatGateFinding", () => {
  test("names the file, line, column, and message", () => {
    expect(formatGateFinding(finding("test/a.test.ts", PRESENCE, 4, 9))).toBe(
      `test/a.test.ts:4:9 ${PRESENCE}`,
    );
  });
});

describe("annotationLines", () => {
  test("emits nothing outside CI", () => {
    expect(
      annotationLines([finding("test/a.test.ts", PRESENCE)], [], false),
    ).toEqual([]);
  });

  test("marks every finding the gate reports as an error", () => {
    const added = finding(
      "test/a.test.ts",
      "truthiness assertion; prefer an exact value or contract-specific matcher",
      2,
    );
    const existing = finding("test/a.test.ts", PRESENCE, 1);
    expect(annotationLines([added], [existing], true)).toEqual([
      "::error file=test/a.test.ts,line=2::truthiness assertion; prefer an exact value or contract-specific matcher",
      `::error file=test/a.test.ts,line=1::${PRESENCE}`,
    ]);
  });

  test("escapes annotation values", () => {
    const lines = annotationLines(
      [finding("test/a.test.ts", "message\nwith % and \r", 1)],
      [],
      true,
    );
    expect(lines[0]).toContain("::message%0Awith %25 and %0D");
  });

  test("caps the annotations and names the omitted count", () => {
    const many = Array.from({ length: 105 }, (_, index) =>
      finding("test/a.test.ts", PRESENCE, index + 1),
    );
    const lines = annotationLines([], many, true);
    expect(lines).toHaveLength(101);
    assertStringIncludes(
      lines[100]!,
      "5 additional weak-assertion annotations omitted",
    );
  });
});
