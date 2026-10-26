import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatQualityFinding,
  gateReport,
  MAX_QUALITY_ANNOTATIONS,
  qualityAnnotations,
  qualityVerdict,
} from "#scripts/check-test-quality/report.ts";

const finding = (
  path: string,
  line = 10,
  message = "presence-only assertion; prefer checking the value, shape, or invariant",
) => ({ column: 5, line, message, path });

describe("check-test-quality report", () => {
  test("names every finding with its position in the informational report", () => {
    const verdict = qualityVerdict(
      [finding("test/a.test.ts", 12), finding("test/b.test.ts", 30)],
      [],
    );
    expect(verdict.informational[0]).toBe(
      "Test quality audit found 2 review targets:",
    );
    expect(verdict.informational[1]).toBe("test/a.test.ts:12:5 presence-only assertion; prefer checking the value, shape, or invariant");
  });

  test("the empty audit answers one quiet line", () => {
    const verdict = qualityVerdict([], []);
    expect(verdict.informational).toEqual([
      "Test quality audit found no weak assertion patterns.",
    ]);
    expect(verdict.gateFindings).toEqual([]);
  });

  test("the review gate takes only the findings in files this change touches", () => {
    const touched = finding("test/touched.test.ts", 7, "truthiness assertion; prefer an exact value or contract-specific matcher");
    const elsewhere = finding("test/elsewhere.test.ts");
    const verdict = qualityVerdict([touched, elsewhere], ["test/touched.test.ts"]);
    expect(verdict.gateFindings).toEqual([touched]);
    expect(verdict.gateSkipped).toBe(false);
  });

  test("a checkout without a base ref skips the gate instead of guessing", () => {
    const verdict = qualityVerdict([finding("test/a.test.ts")], null);
    expect(verdict.gateSkipped).toBe(true);
    expect(verdict.gateFindings).toEqual([]);
  });

  test("each finding becomes one file-anchored warning annotation", () => {
    const annotations = qualityAnnotations([
      finding("test/a.test.ts", 12, "truthiness assertion; prefer an exact value or contract-specific matcher"),
    ]);
    expect(annotations).toEqual([
      "::warning file=test/a.test.ts,line=12,col=5::truthiness assertion; prefer an exact value or contract-specific matcher",
    ]);
  });

  test("annotation values cannot smuggle newlines or percent signs", () => {
    const annotations = qualityAnnotations([
      finding("test/a%b.test.ts", 1, "message%0Awith newline\ninside"),
    ]);
    expect(annotations[0]).toBe(
      "::warning file=test/a%25b.test.ts,line=1,col=5::message%250Awith newline%0Ainside",
    );
  });

  test("a backlog wider than the cap keeps the pane readable", () => {
    const findings = Array.from(
      { length: MAX_QUALITY_ANNOTATIONS + 3 },
      (_, i) => finding(`test/f${i}.test.ts`, i + 1),
    );
    const annotations = qualityAnnotations(findings);
    expect(annotations).toHaveLength(MAX_QUALITY_ANNOTATIONS + 1);
    expect(annotations[MAX_QUALITY_ANNOTATIONS]).toBe(
      "::warning::3 further weak-assertion findings omitted",
    );
  });

  test("the gate failure names the fix and lists the findings", () => {
    const lines = gateReport([finding("test/touched.test.ts", 7, "truthiness assertion; prefer an exact value or contract-specific matcher")]);
    expect(lines[0]).toBe(
      "The test files this change touches carry weak assertion patterns.",
    );
    expect(lines[2]).toBe("test/touched.test.ts:7:5 truthiness assertion; prefer an exact value or contract-specific matcher");
  });

  test("one finding renders as its position and message", () => {
    expect(formatQualityFinding(finding("test/a.test.ts", 3, "test has no visible assertion"))).toBe(
      "test/a.test.ts:3:5 test has no visible assertion",
    );
  });
});
