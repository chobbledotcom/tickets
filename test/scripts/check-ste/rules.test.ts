import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findIssues, proseLines } from "#scripts/check-ste/rules.ts";

const issuesOn = (line: string) => findIssues(`${line}\n`);
const rulesOn = (line: string) => issuesOn(line).map((issue) => issue.rule);

describe("check-ste rules", () => {
  describe("contract data", () => {
    test("sees a rule's finding as one issue and reports it in line order", () => {
      const issues = findIssues(
        "This has been done.\nIt's fine.\nKeep it; do not lose it.\n",
      );
      expect(issues.map((issue) => issue.rule)).toEqual([
        "present-perfect",
        "contraction",
        "semicolon",
      ]);
      expect(issues.map((issue) => issue.line)).toEqual([1, 2, 3]);
    });

    test("reports the prose a rule flags with its fix", () => {
      const [issue] = issuesOn("Run this simply to utilize the cache.");
      expect(issue?.problem).toBe('"simply"');
      expect(rulesOn("Run this simply to utilize the cache.")).toEqual([
        "wordy",
        "wordy",
      ]);
    });
  });

  describe("what the machine does not read", () => {
    test("never reads fenced code blocks", () => {
      const content = "```\nRun this; it should work.\n```\n";
      expect(findIssues(content)).toEqual([]);
    });

    test("never reads table rows", () => {
      const content = '| "has been; done" | should |\n';
      expect(findIssues(content)).toEqual([]);
    });

    test("never reads inline code, quoted words, or link targets", () => {
      expect(
        proseLines("Use `should` now. [See docs](http://x?a=b;c=d)\n")[0]?.text,
      ).toBe("Use % now. [See docs%");
      expect(rulesOn('Say "would" here.')).toEqual([]);
      expect(rulesOn("Use `would` here.")).toEqual([]);
    });

    test("blanks a quoted span that wraps across lines, keeping line numbers", () => {
      const content = 'The bad text is "a would;\nhere" and more would.\n';
      expect(rulesOn(content)).toEqual(["banned-modal"]);
      const [issue] = findIssues(content);
      expect(issue?.line).toBe(2);
    });

    test("keeps the line numbers of every prose line", () => {
      const lines = proseLines("one\n```\ncode\n```\nfour\n");
      expect(lines.map((line) => line.line)).toEqual([1, 5, 6]);
    });

    test("leaves a line reading as inside the fence, whatever its marker", () => {
      // A ``` block holding a ~~~ line: the tilde line is code, and prose
      // after the block still reads.
      const content = "before\n```\nwrap\n~~~\nstill code\n```\nafter\n";
      expect(
        findIssues(content.replace("before", "a;").replace("after", "b;")),
      ).toEqual([
        {
          fix: "write two sentences",
          line: 1,
          problem: '";"',
          rule: "semicolon",
        },
        {
          fix: "write two sentences",
          line: 7,
          problem: '";"',
          rule: "semicolon",
        },
      ]);
    });

    test("leaves a tilde block holding a backtick line inside too", () => {
      const content = "a;\n~~~\n```\ninside\n~~~\nb;\n";
      expect(findIssues(content).map((issue) => issue.line)).toEqual([1, 6]);
    });

    test("closes only on a fence at least as long as its opener", () => {
      // Four backticks open; three are content, not a close.
      const content = "````\n```\n````\ncoffee; cup\n";
      expect(proseLines(content).map((line) => line.text)).toEqual([
        "coffee; cup",
        "",
      ]);
    });
  });

  describe("each rule", () => {
    test("contraction flags pronoun short forms and every n't", () => {
      expect(
        rulesOn("It's fine. It isn't here. You're done. We've got it."),
      ).toEqual(["contraction", "contraction", "contraction", "contraction"]);
    });

    test("contraction leaves a possessive noun alone", () => {
      expect(rulesOn("The site's name stays.")).toEqual([]);
    });

    test("contraction flags the 'd short form of a modal", () => {
      expect(rulesOn("They'd retry. We'd stop.")).toEqual([
        "contraction",
        "contraction",
      ]);
    });

    test("present-perfect flags has, have, and had been", () => {
      expect(rulesOn("The column has been added.")).toEqual([
        "present-perfect",
      ]);
      expect(rulesOn("The columns have been added.")).toEqual([
        "present-perfect",
      ]);
    });

    test("banned-modal flags the modals the guide bans", () => {
      expect(rulesOn("Run it. It should work and it could fail.")).toEqual([
        "banned-modal",
        "banned-modal",
      ]);
      expect(rulesOn("It may fail.")).toEqual(["banned-modal"]);
    });

    test("banned-modal flags a sentence-initial Should, Would, or Could", () => {
      expect(rulesOn("Should the test fail, read the log.")).toEqual([
        "banned-modal",
      ]);
      expect(rulesOn("Would this work?")).toEqual(["banned-modal"]);
    });

    test("banned-modal leaves May the month alone", () => {
      expect(rulesOn("The deploy runs in May.")).toEqual([]);
    });

    test("banned-modal leaves the inside of a word alone", () => {
      expect(rulesOn("The mightiest shield.")).toEqual([]);
    });

    test("semicolon flags a semicolon in prose", () => {
      expect(rulesOn("Write two; not one.")).toEqual(["semicolon"]);
    });

    test("participle flags a comma plus one -ing clause word", () => {
      expect(rulesOn("Run it, making it easy.")).toEqual(["participle"]);
      expect(rulesOn("Run it, allowing more.")).toEqual(["participle"]);
    });

    test("participle flags every clause on a line, not only the first", () => {
      expect(rulesOn("Run it, making it easy, hiding the cost.")).toEqual([
        "participle",
        "participle",
      ]);
    });

    test("participle leaves a sentence without the pattern alone", () => {
      expect(rulesOn("Run it and make it easy.")).toEqual([]);
    });

    test("wordy flags each banned word with its own fix", () => {
      const issues = issuesOn("Prior to this, in order to run it.");
      expect(issues.map((issue) => issue.problem)).toEqual([
        '"in order to"',
        '"Prior to"',
      ]);
      expect(issues[0]?.fix).toBe('write "to"');
      expect(issues[1]?.fix).toBe('write "before"');
    });

    test("wordy flags e.g. with periods, but not inside a longer word", () => {
      expect(rulesOn("Run it, e.g. now.")).toEqual(["wordy"]);
      expect(rulesOn("Utilized text stays.")).toEqual([]);
    });
  });
});
