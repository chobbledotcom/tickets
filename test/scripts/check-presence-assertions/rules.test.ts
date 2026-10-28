import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  countsByPath,
  findIssues,
  presenceFindings,
} from "#scripts/check-presence-assertions/rules.ts";

describe("check-presence-assertions rules", () => {
  const FLAG = {
    fix: "assert the value, shape, or invariant instead",
    problem: "presence-only assertion: toBeDefined() checks presence alone",
    rule: "presence-only",
  };

  test("finds a toBeDefined call with its line", () => {
    const content = 'test("a", () => {\n  expect(value).toBeDefined();\n});\n';
    expect(
      presenceFindings("fixture.test.ts", content).map((finding) => [
        finding.line,
        finding.message,
      ]),
    ).toEqual([[2, "presence-only"]]);
  });

  test("leaves a commented-out call and a string alone", () => {
    const content =
      '// expect(value).toBeDefined();\nconst note = "expect(x).toBeDefined();";\n';
    expect(presenceFindings("fixture.test.ts", content)).toEqual([]);
  });

  test("leaves the exact matcher toBeUndefined alone", () => {
    expect(
      presenceFindings("fixture.test.ts", "expect(result).toBeUndefined();\n"),
    ).toEqual([]);
  });

  test("counts findings per file and leaves files without findings out", () => {
    const counts = countsByPath([
      { column: 1, line: 2, message: "presence-only", path: "a.test.ts" },
      { column: 1, line: 9, message: "presence-only", path: "a.test.ts" },
      { column: 1, line: 4, message: "presence-only", path: "b.test.ts" },
    ]);
    expect(counts).toEqual({ "a.test.ts": 2, "b.test.ts": 1 });
  });

  test("flags every call in a file no entry covers", () => {
    const content =
      "expect(value).toBeDefined();\nexpect(other).toBeDefined();\n";
    expect(findIssues("fixture.test.ts", content, {})).toEqual([
      { ...FLAG, line: 1 },
      { ...FLAG, line: 2 },
    ]);
  });

  test("flags only the calls past the recorded count, in source order", () => {
    const content =
      "expect(value).toBeDefined();\nexpect(other).toBeDefined();\n";
    expect(
      findIssues("fixture.test.ts", content, { "fixture.test.ts": 1 }),
    ).toEqual([{ ...FLAG, line: 2 }]);
  });

  test("leaves a file at its recorded count alone", () => {
    expect(
      findIssues("fixture.test.ts", "expect(value).toBeDefined();\n", {
        "fixture.test.ts": 1,
      }),
    ).toEqual([]);
  });

  test("asks for the fallen count to be recorded", () => {
    expect(
      findIssues("fixture.test.ts", "expect(value).toBeDefined();\n", {
        "fixture.test.ts": 3,
      }),
    ).toEqual([
      {
        fix: "run `deno task check:presence-assertions --update` to record the count",
        line: 1,
        problem: "holds 1 presence-only assertions, fewer than the recorded 3",
        rule: "improved",
      },
    ]);
  });

  test("asks for the entry's deletion once the file holds no call", () => {
    expect(
      findIssues("fixture.test.ts", "expect(value).toBeUndefined();\n", {
        "fixture.test.ts": 1,
      }),
    ).toEqual([
      {
        fix: "delete the entry in scripts/check-presence-assertions/registry.json",
        line: 1,
        problem: "holds no presence-only assertion",
        rule: "stale-entry",
      },
    ]);
  });

  test("leaves a file with no call and no entry alone", () => {
    expect(
      findIssues("fixture.test.ts", "expect(value).toBe(1);\n", {}),
    ).toEqual([]);
  });
});
