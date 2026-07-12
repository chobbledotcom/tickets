import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  type CopyEntry,
  findIssues,
  formatIssue,
  PLAIN_WORDS,
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

  test("flags a formal word and suggests the plain twin", () => {
    const issues = findIssues([entry("Please utilise this page")]);
    expect(issues).toEqual([
      {
        file: "test.json",
        fix: 'use "use"',
        key: "test.key",
        problem: 'formal word "utilise"',
        rule: "plain-words",
      },
    ]);
  });

  test("flags a formal phrase spanning several words", () => {
    const issues = findIssues([entry("Save your work in order to continue")]);
    expect(issues[0]).toMatchObject({
      fix: 'use "to"',
      problem: 'formal word "in order to"',
      rule: "plain-words",
    });
  });

  test("matches formal words regardless of case", () => {
    const issues = findIssues([entry("Whilst you wait")]);
    expect(issues[0]!.problem).toBe('formal word "Whilst"');
    expect(issues[0]!.fix).toBe('use "while"');
  });

  test("does not flag a plain everyday word", () => {
    expect(findIssues([entry("Use this page to start")])).toEqual([]);
  });

  test("does not treat a formal word inside <code> as prose", () => {
    expect(findIssues([entry("Endpoint <code>/commence</code>")])).toEqual([]);
  });

  test("collects issues across many entries and rules", () => {
    const issues = findIssues([
      { file: "a.json", key: "a.one", value: "Click here" },
      { file: "a.json", key: "a.two", value: "All good" },
      { file: "b.json", key: "b.one", value: "utilise  it" },
    ]);
    expect(issues.map((i) => `${i.key}:${i.rule}`)).toEqual([
      "a.one:descriptive-links",
      "b.one:double-space",
      "b.one:plain-words",
    ]);
  });

  test("every plain-word suggestion is resolvable", () => {
    for (const { avoid } of PLAIN_WORDS) {
      const issues = findIssues([entry(`x ${avoid} y`)]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.fix.startsWith('use "')).toBe(true);
    }
  });

  test("exposes exactly the three rules", () => {
    expect(RULES.map((r) => r.name)).toEqual([
      "double-space",
      "descriptive-links",
      "plain-words",
    ]);
  });

  test("formats an issue as a readable line", () => {
    expect(
      formatIssue({
        file: "errors.json",
        fix: 'use "use"',
        key: "error.x",
        problem: 'formal word "utilise"',
        rule: "plain-words",
      }),
    ).toBe(
      'errors.json error.x [plain-words]: formal word "utilise" — use "use"',
    );
  });
});

describe("check-copy runner", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /** Write one catalog file, run the check over the temp folder, and hand back
   * the exit code plus the lines sent to each logger. */
  const checkCatalog = (
    fileName: string,
    contents: Record<string, unknown>,
  ) => {
    Deno.writeTextFileSync(`${dir}/${fileName}`, JSON.stringify(contents));
    const out: string[] = [];
    const errors: string[] = [];
    const code = runCopyCheck(
      dir,
      (l) => out.push(l),
      (l) => errors.push(l),
    );
    return { code, errors, out };
  };

  test("reads string values from every .json file, sorted, skipping the rest", () => {
    Deno.writeTextFileSync(
      `${dir}/b.json`,
      JSON.stringify({ "b.one": "first", "b.two": "second" }),
    );
    Deno.writeTextFileSync(
      `${dir}/a.json`,
      JSON.stringify({ "a.count": 3, "a.text": "hello" }),
    );
    Deno.writeTextFileSync(`${dir}/notes.txt`, "ignored");

    expect(readCatalog(dir)).toEqual([
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
      `All user-facing copy in ${dir} passes the simple-language checks.`,
    ]);
  });

  test("returns 1 and logs each issue when the catalog has problems", () => {
    const { code, out, errors } = checkCatalog("bad.json", {
      "bad.msg": "Please utilise this,  click here",
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(errors.some((l) => l.includes("double-space"))).toBe(true);
    expect(errors.some((l) => l.includes("descriptive-links"))).toBe(true);
    expect(errors.some((l) => l.includes("plain-words"))).toBe(true);
    expect(errors.at(-1)).toContain("simple-language issue(s) found");
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
