import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { reportCheck } from "#scripts/check-report.ts";

describe("reportCheck", () => {
  let logs: string[] = [];
  let errors: string[] = [];
  const base = {
    guide: '"Comments are short" in AGENTS.md',
    log: (line: string) => logs.push(line),
    logError: (line: string) => errors.push(line),
    noun: "comment",
    success: "All clean.",
  };

  beforeEach(() => {
    logs = [];
    errors = [];
  });

  test("logs the success line and returns 0 when nothing was found", () => {
    expect(reportCheck({ ...base, found: [] })).toBe(0);
    expect(logs).toEqual(["All clean."]);
    expect(errors).toEqual([]);
  });

  test("logs every finding in order and returns 1", () => {
    expect(reportCheck({ ...base, found: ["first", "second"] })).toBe(1);
    expect(errors.slice(0, 2)).toEqual(["first", "second"]);
    expect(logs).toEqual([]);
  });

  test("closes with the count and where the rule is written down", () => {
    reportCheck({ ...base, found: ["a", "b", "c"] });
    expect(errors.at(-1)).toBe(
      '\n3 comment issue(s) found. See "Comments are short" in AGENTS.md.',
    );
  });

  test("counts one finding as one", () => {
    reportCheck({ ...base, found: ["only"] });
    expect(errors.at(-1)).toContain("1 comment issue(s) found");
  });

  test("uses the caller's noun and guide", () => {
    reportCheck({
      ...base,
      found: ["x"],
      guide: "the Simple Language section",
      noun: "simple-language",
    });
    expect(errors.at(-1)).toBe(
      "\n1 simple-language issue(s) found. See the Simple Language section.",
    );
  });
});
