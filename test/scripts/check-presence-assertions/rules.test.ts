import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
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

  test("flags every call in a file", () => {
    const content =
      "expect(value).toBeDefined();\nexpect(other).toBeDefined();\n";
    expect(findIssues("fixture.test.ts", content)).toEqual([
      { ...FLAG, line: 1 },
      { ...FLAG, line: 2 },
    ]);
  });

  test("leaves a file with no call alone", () => {
    expect(findIssues("fixture.test.ts", "expect(value).toBe(1);\n")).toEqual(
      [],
    );
  });
});
