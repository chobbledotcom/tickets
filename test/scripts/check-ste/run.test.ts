import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type DocumentFile, runSteCheck } from "#scripts/check-ste/run.ts";

describe("check-ste runner", () => {
  const output = {
    log: () => {},
    logError: () => {},
  };

  const file = (path: string, content: string): DocumentFile => ({
    content,
    path,
  });

  test("passes a document at its baseline", () => {
    const files = [file("a.md", "Write it; then stop.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      {},
      { "a.md": 1 },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
  });

  test("fails with every issue when a document rises above its baseline", () => {
    const files = [file("a.md", "Write it; then stop.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      {},
      { "a.md": 0 },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(errors).toEqual([
      'a.md:1 [semicolon]: ";" — write two sentences',
      "\n1 technical-english issue(s) found. See " +
        'the "Simplified Technical English" section of AGENTS.md.',
    ]);
  });

  test("fails when a document improves, so the entry lands with its step", () => {
    const files = [file("a.md", "Write it.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      {},
      { "a.md": 2 },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toBe(
      "a.md [improved]: 0 issue(s), baseline says 2 — lower the entry in " +
        "scripts/check-ste/baseline.json",
    );
  });

  test("a document with no entry must be clean", () => {
    const files = [file("new.md", "Write it; then stop.\n")];
    expect(runSteCheck(files, {}, {}, output)).toBe(1);
    expect(runSteCheck(files, {}, { "new.md": 1 }, output)).toBe(0);
  });

  test("skips a record document, however it reads", () => {
    const files = [file("plan.md", "It's been; simply made, would you not.\n")];
    expect(runSteCheck(files, { "plan.md": "a record" }, {}, output)).toBe(0);
  });

  test("fails for a records or baseline entry that names no document", () => {
    const files = [file("a.md", "Write it.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      { "gone.md": "a record" },
      {
        "also-gone.md": 0,
      },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toContain("also-gone.md");
    expect(errors[0]).toContain("baseline.json");
    expect(errors[1]).toContain("gone.md");
    expect(errors[1]).toContain("records.json");
  });

  test("logs the success line when everything matches", () => {
    const lines: string[] = [];
    const code = runSteCheck(
      [file("a.md", "Write it.\n")],
      {},
      {},
      { ...output, log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([
      "Every policy document passes the simplified-technical-english checks.",
    ]);
  });
});
