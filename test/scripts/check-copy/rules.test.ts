import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CopyEntry,
  findIssues,
  formatIssue,
  RULES,
} from "#scripts/check-copy/rules.ts";

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

  test("flags a vague link whose words are split by a formatting tag", () => {
    const issues = findIssues([entry("Click<em>here</em> to start")]);
    expect(issues.map((i) => `${i.rule}:${i.problem}`)).toEqual([
      'descriptive-links:vague link text "Click here"',
    ]);
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
