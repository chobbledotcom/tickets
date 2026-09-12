import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { countLines, findIssues } from "#scripts/check-file-lengths/rules.ts";

describe("check-file-lengths rules", () => {
  test("counts the lines one file's content holds", () => {
    expect(countLines("a\nb\nc\n")).toBe(4);
    expect(countLines("a")).toBe(1);
  });

  test("flags a file over the limit that no entry covers", () => {
    const [issue] = findIssues("big.ts", "\n".repeat(500), 400, {});
    expect(issue?.rule).toBe("over-limit");
    expect(issue?.problem).toContain("501 lines");
    expect(issue?.fix).toBe("split the file");
  });

  test("lets a file at the limit stand", () => {
    const lines = "\n".repeat(59);
    expect(findIssues("small.ts", lines, 60, {})).toEqual([]);
  });

  test("flags a covered file that grew past its recorded count", () => {
    const [issue] = findIssues("grew.ts", "\n".repeat(40), 30, {
      "grew.ts": 35,
    });
    expect(issue?.rule).toBe("over-limit");
    expect(issue?.problem).toContain("grew from 35");
  });

  test("fails when a covered file shrank, so the step lands with its entry", () => {
    const [issue] = findIssues("shrank.ts", "\n".repeat(30), 30, {
      "shrank.ts": 35,
    });
    expect(issue?.rule).toBe("improved");
    expect(issue?.problem).toContain("from 35 lines to 31");
  });

  test("fails when an entry names a file now under the limit", () => {
    const [issue] = findIssues("done.ts", "\n".repeat(10), 30, {
      "done.ts": 35,
    });
    expect(issue?.rule).toBe("stale-entry");
    expect(issue?.fix).toContain("delete the entry");
  });

  test("leaves a covered file at its recorded count alone", () => {
    expect(
      findIssues("held.ts", "\n".repeat(34), 30, { "held.ts": 35 }),
    ).toEqual([]);
  });
});
