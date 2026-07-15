import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import {
  type CopyEntry,
  findIssues,
  formatIssue,
  RULES,
} from "../../scripts/check-copy/rules.ts";
import { readCatalog, runCopyCheck } from "../../scripts/check-copy/run.ts";

const entry = (value: string): CopyEntry => ({
  file: "test.json",
  key: "test.key",
  value,
});

describe("check-copy rules", () => {
  test("flags two or more spaces in a row", () => {
    const issues = findIssues([entry("Save  changes")]);
    expect(issues).toEqual([
      {
        file: "test.json",
        fix: "use a single space",
        key: "test.key",
        problem: "two or more spaces in a row",
        rule: "double-space",
      },
    ]);
  });

  test("does not flag single spaces", () => {
    expect(findIssues([entry("Save your changes now")])).toEqual([]);
  });

  test("ignores spacing inside <code> and <pre> examples", () => {
    const html = "Run <code>a    b</code> then <pre>x    y</pre> and stop";
    expect(findIssues([entry(html)])).toEqual([]);
  });

  test("does not read inline markup as a double space", () => {
    const html = "Hello <strong>world</strong> and <em>friends</em>";
    expect(findIssues([entry(html)])).toEqual([]);
  });

  test("still flags a genuine double space around inline markup", () => {
    expect(findIssues([entry("Hello  <strong>world</strong>")])).toEqual([
      {
        file: "test.json",
        fix: "use a single space",
        key: "test.key",
        problem: "two or more spaces in a row",
        rule: "double-space",
      },
    ]);
  });

  test("flags vague link text and names the destination", () => {
    const issues = findIssues([entry("Click here to view your ticket")]);
    expect(issues).toEqual([
      {
        file: "test.json",
        fix: 'name the destination, e.g. "View your ticket"',
        key: "test.key",
        problem: 'vague link text "Click here"',
        rule: "descriptive-links",
      },
    ]);
  });

  test("flags 'tap below' as well as 'click here'", () => {
    const issues = findIssues([entry("Tap below to pay")]);
    expect(issues.map((i) => i.rule)).toEqual(["descriptive-links"]);
    expect(issues[0]!.problem).toBe('vague link text "Tap below"');
  });

  test("reports one vague-link finding even when it repeats", () => {
    const issues = findIssues([entry("Click here, or Click here again")]);
    expect(issues).toHaveLength(1);
  });

  test("does not flag descriptive link text", () => {
    expect(findIssues([entry("View your ticket")])).toEqual([]);
  });

  test("collects issues across many entries and rules", () => {
    const issues = findIssues([
      { file: "a.json", key: "a.one", value: "Click here" },
      { file: "a.json", key: "a.two", value: "All good" },
      { file: "b.json", key: "b.one", value: "spaced  out" },
    ]);
    expect(issues.map((i) => `${i.key}:${i.rule}`)).toEqual([
      "a.one:descriptive-links",
      "b.one:double-space",
    ]);
  });

  test("does not match a vague-link phrase split by a code example", () => {
    expect(findIssues([entry("Click <code>x</code> here")])).toEqual([]);
  });

  test("still flags a vague link in a segment beside a code example", () => {
    const issues = findIssues([
      entry("Click here after <code>setup</code> to begin"),
    ]);
    expect(issues.map((i) => `${i.rule}:${i.problem}`)).toEqual([
      'descriptive-links:vague link text "Click here"',
    ]);
  });

  test("exposes exactly the two rules", () => {
    expect(RULES.map((r) => r.name)).toEqual([
      "double-space",
      "descriptive-links",
    ]);
  });

  test("formats an issue as a readable line", () => {
    expect(
      formatIssue({
        file: "errors.json",
        fix: "use a single space",
        key: "error.x",
        problem: "two or more spaces in a row",
        rule: "double-space",
      }),
    ).toBe(
      "errors.json error.x [double-space]: two or more spaces in a row — use a single space",
    );
  });
});

describe("check-copy runner", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  /** Write one catalog file, run the check over the temp folder, and hand back
   * the exit code plus the lines sent to each logger. */
  const checkCatalog = (
    fileName: string,
    contents: Record<string, unknown>,
  ) => {
    Deno.writeTextFileSync(`${dir.path}/${fileName}`, JSON.stringify(contents));
    const out: string[] = [];
    const errors: string[] = [];
    const code = runCopyCheck(
      dir.path,
      (l) => out.push(l),
      (l) => errors.push(l),
    );
    return { code, errors, out };
  };

  test("reads string values from every .json file, sorted, skipping the rest", () => {
    Deno.writeTextFileSync(
      `${dir.path}/b.json`,
      JSON.stringify({ "b.one": "first", "b.two": "second" }),
    );
    Deno.writeTextFileSync(
      `${dir.path}/a.json`,
      JSON.stringify({ "a.count": 3, "a.text": "hello" }),
    );
    Deno.writeTextFileSync(`${dir.path}/notes.txt`, "ignored");

    expect(readCatalog(dir.path)).toEqual([
      { file: "a.json", key: "a.text", value: "hello" },
      { file: "b.json", key: "b.one", value: "first" },
      { file: "b.json", key: "b.two", value: "second" },
    ]);
  });

  test("returns 0 and logs success when the catalog is clean", () => {
    const { code, out, errors } = checkCatalog("ok.json", {
      "ok.msg": "View your ticket now.",
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toEqual([
      `All user-facing copy in ${dir.path} passes the simple-language checks.`,
    ]);
  });

  test("returns 1 and logs each issue in rule order, then a summary", () => {
    const { code, out, errors } = checkCatalog("bad.json", {
      "bad.msg": "Please read this,  click here",
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(errors).toEqual([
      "bad.json bad.msg [double-space]: two or more spaces in a row — use a single space",
      'bad.json bad.msg [descriptive-links]: vague link text "click here" — name the destination, e.g. "View your ticket"',
      '\n2 simple-language issue(s) found. See the "Simple Language" section of AGENTS.md.',
    ]);
  });
});

describe("the real copy catalog", () => {
  test("passes every mechanical simple-language check", () => {
    const errors: string[] = [];
    const code = runCopyCheck(
      "src/locales/en",
      () => {},
      (l) => errors.push(l),
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });
});
