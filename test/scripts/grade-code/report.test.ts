import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  batchReportLines,
  csvLines,
  type GradedCode,
  type ReportRow,
  singleReportLines,
  summarise,
  type UngradedCode,
  worstFirst,
} from "#scripts/grade-code/report.ts";

const row = (parts: Partial<ReportRow>): ReportRow => ({
  critical: false,
  engine: "code",
  goodness: 1,
  label: "Check",
  note: "fine",
  status: "PASS",
  weight: 2,
  ...parts,
});

const graded = (parts: Partial<GradedCode>): GradedCode => ({
  checks: {},
  counts: { FAIL: 0, PASS: 0, WARN: 0 },
  error: null,
  file: "src/features/admin/a.ts",
  jev: null,
  jevError: null,
  kind: "feature",
  letter: "A",
  lines: 10,
  score: 100,
  seconds: 0.1,
  ...parts,
});

const ungraded = (parts: Partial<UngradedCode>): UngradedCode => ({
  checks: {},
  counts: { FAIL: 0, PASS: 0, WARN: 0 },
  error: "could not grade",
  file: "src/c.ts",
  jev: null,
  jevError: null,
  kind: "feature",
  letter: "E",
  lines: 0,
  score: null,
  seconds: 0.1,
  ...parts,
});

describe("summarise", () => {
  test("weights each check by the share it earned", () => {
    const summary = summarise({
      a: row({ goodness: 1, status: "PASS", weight: 4 }),
      b: row({ goodness: 0.5, status: "WARN", weight: 4 }),
      c: row({ goodness: 0, status: "FAIL", weight: 2 }),
    });
    expect(summary.score).toBe(60);
    expect(summary.letter).toBe("C");
    expect(summary.counts).toEqual({ FAIL: 1, PASS: 1, WARN: 1 });
  });

  test("scores a file with no checks at all", () => {
    expect(summarise({})).toEqual({
      counts: { FAIL: 0, PASS: 0, WARN: 0 },
      letter: "F",
      score: 0,
    });
  });

  test("drops skipped checks from the weight and the counts", () => {
    const summary = summarise({
      a: row({ goodness: 1, status: "PASS", weight: 4 }),
      skipped: row({ goodness: 0, status: "SKIP", weight: 100 }),
    });
    expect(summary.score).toBe(100);
    expect(summary.counts.PASS).toBe(1);
  });

  test("lands on each letter boundary", () => {
    const grade = (score: number): string =>
      summarise({ a: row({ goodness: score / 100, weight: 100 }) }).letter;
    expect(grade(90)).toBe("A");
    expect(grade(75)).toBe("B");
    expect(grade(60)).toBe("C");
    expect(grade(45)).toBe("D");
    expect(grade(44)).toBe("F");
  });
});

describe("singleReportLines", () => {
  const result = graded({
    checks: {
      a: row({ label: "Fine check", note: "all good" }),
      b: row({
        critical: true,
        engine: "jev",
        goodness: 0,
        label: "Broken check",
        note: "two imports",
        status: "FAIL",
      }),
    },
    counts: { FAIL: 1, PASS: 1, WARN: 0 },
    jev: { model: "jev-1.13", seconds: 1.25, tokens: "10 in / 5 out tokens" },
    letter: "F",
    score: 50,
  });

  test("prints every check, the score, the call, and the critical failure", () => {
    const lines = singleReportLines(result);
    expect(lines[0]).toContain(
      "src/features/admin/a.ts (feature, 10 lines, 2 checks)",
    );
    expect(lines.join("\n")).toContain("  [+] PASS Fine check");
    expect(lines.join("\n")).toContain("(code w2) all good");
    expect(lines.join("\n")).toContain("  [X] FAIL Broken check");
    expect(lines.join("\n")).toContain("(jev  w2) two imports [CRITICAL]");
    expect(lines).toContain("Score: 50/100 (F) - 1 pass, 0 warn, 1 fail");
    expect(lines).toContain("Jev: model=jev-1.13, 10 in / 5 out tokens, 1.25s");
    expect(lines).toContain("CRITICAL: Broken check: two imports");
  });

  test("prints the call without token counts when jev reports none", () => {
    const lines = singleReportLines(
      graded({ jev: { model: "jev-1.13", seconds: 1 }, score: 100 }),
    );
    expect(lines).toContain("Jev: model=jev-1.13, 1.00s");
  });
});

describe("batchReportLines", () => {
  test("ranks worst first, separates errored files, and aggregates", () => {
    const lines = batchReportLines(
      [
        graded({ score: 100 }),
        graded({
          checks: {
            a: row({ goodness: 0, label: "Alpha check", status: "FAIL" }),
            b: row({ goodness: 0, label: "Beta check", status: "FAIL" }),
            c: row({ goodness: 0.5, status: "WARN" }),
          },
          file: "src/b.ts",
          letter: "F",
          score: 40,
        }),
        ungraded({ error: "SyntaxError: boom", file: "src/c.ts" }),
      ].sort(worstFirst),
      { model: "jev-1.13", seconds: 3 },
    );
    const files = lines.filter((line) => line.includes("src/"));
    expect(files.findIndex((line) => line.includes("src/b.ts"))).toBe(0);
    expect(files.findIndex((line) => line.includes("admin/a.ts"))).toBe(1);
    expect(files.findIndex((line) => line.includes("src/c.ts"))).toBe(2);
    expect(lines).toContain(
      "2 graded, 1 errored, 0 Jev failed | median 70 | A:1 F:1 | 3s total",
    );
    expect(lines).toContain("Most-failed checks across the batch:");
    expect(lines).toContain("Most-warned checks across the batch:");
    expect(lines).toContain("  x1    Check");
  });

  test("ranks a file Jev failed on apart from complete grades", () => {
    const lines = batchReportLines(
      [
        ungraded({ error: "nope", file: "src/c.ts" }),
        graded({ file: "src/full.ts", letter: "C", score: 60 }),
        graded({
          checks: { a: row({ goodness: 0, label: "Alpha", status: "FAIL" }) },
          file: "src/partial.ts",
          jevError: "HTTP 429: slow down",
          score: 100,
        }),
      ].sort(worstFirst),
      { model: "jev-1.13", seconds: 3 },
    );
    const files = lines.filter((line) => line.includes("src/"));
    expect(files[0]).toContain("src/full.ts");
    expect(files[1]).toContain(
      "src/partial.ts - Jev failed: HTTP 429: slow down",
    );
    expect(files[2]).toContain("src/c.ts");
    expect(lines).toContain(
      "1 graded, 1 errored, 1 Jev failed | median 60 | C:1 | 3s total",
    );
    expect(lines).toContain("  x1    Alpha");
  });

  test("prints no median when Jev failed on every file", () => {
    const lines = batchReportLines(
      [graded({ jevError: "HTTP 402: no credits" })],
      { model: "jev-1.13", seconds: 3 },
    );
    expect(lines).toContain("0 graded, 0 errored, 1 Jev failed | 3s total");
  });

  test("stops after the table when no file could be graded", () => {
    const lines = batchReportLines(
      [ungraded({ error: "nope", file: "src/c.ts" })],
      { model: "jev-1.13", seconds: 3 },
    );
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("src/c.ts - nope");
  });
});

describe("csvLines", () => {
  test("writes a header row and one quoted row per file", () => {
    const lines = csvLines([
      graded({}),
      graded({
        checks: { a: row({ goodness: 0, status: "FAIL" }) },
        file: "weird,name.ts",
        score: 20,
      }),
      ungraded({ error: 'boom "today"', file: "src/gone.ts" }),
    ]);
    expect(lines[0]).toBe(
      "score,letter,kind,file,pass,warn,fail,failed_checks,jev_error,error",
    );
    expect(lines[2]).toContain('"weird,name.ts"');
    expect(lines[3]).toContain('"boom ""today"""');
  });
});
