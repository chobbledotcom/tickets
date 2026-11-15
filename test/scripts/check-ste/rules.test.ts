import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { proseBlocks } from "#scripts/check-ste/prose.ts";
import { findIssues } from "#scripts/check-ste/rules.ts";
import { testCases } from "#test-utils/test-cases.ts";

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

    test("never reads indented code blocks", () => {
      const content =
        "Prose before.\n\n    Run this; it should work.\n\n    More code; still code.\n\nProse after.\n";
      expect(findIssues(content)).toEqual([]);
      // A blank line inside the block does not close it.
      expect(rulesOn(content)).toEqual([]);
    });

    test("keeps reading an indented line that continues a paragraph", () => {
      const content = "Text\n    Should this continue?\n";
      expect(rulesOn(content)).toEqual(["banned-modal"]);
      assertStringIncludes(proseBlocks(content)[0]!.text, "Should");
    });

    test("never reads table rows", () => {
      const content =
        '| left | right |\n| --- | --- |\n| "has been; done" | should |\n';
      expect(findIssues(content)).toEqual([]);
    });

    test("never reads inline code or link targets", () => {
      expect(
        proseBlocks("Use `should` now. [See docs](http://x?a=b;c=d)\n")[0]
          ?.text,
      ).toBe("Use % now. See docs");
      expect(rulesOn("Use `would` here.")).toEqual([]);
    });

    test("reads a quoted span that wraps across lines, keeping line numbers", () => {
      const content = 'The bad text is "a would\nhere" and more would.\n';
      expect(rulesOn(content)).toEqual(["banned-modal", "banned-modal"]);
      expect(findIssues(content).map((issue) => issue.line)).toEqual([1, 2]);
    });

    test("blanks the token that fired the link, not an earlier one", () => {
      // The lowercase e.g. before the noun is ordinary prose; the E.G. that
      // links the noun to the quotation is the machine-owned one.
      const issues = findIssues(
        'See e.g. the error sentence — E.G. "should retry".',
      );
      expect(issues.map(({ problem }) => problem)).toEqual(['"e.g."']);
    });

    test("keeps the line numbers of every prose line", () => {
      const blocks = proseBlocks("one\n```\ncode\n```\nfour\n");
      expect(blocks.map((block) => block.lines[0])).toEqual([1, 5]);
    });

    test("leaves a line reading as inside the fence, whatever its marker", () => {
      // A ``` block holding a ~~~ line: the tilde line is code, and prose
      // after the block still reads.
      const content = "a;\n```\nwrap\n~~~\nstill code\n```\nb;\n";
      expect(
        findIssues(content).map((issue) => [issue.line, issue.context]),
      ).toEqual([
        [1, "a;"],
        [7, "b;"],
      ]);
    });

    test("leaves a tilde block holding a backtick line inside too", () => {
      const content = "a;\n~~~\n```\ninside\n~~~\nb;\n";
      expect(findIssues(content).map((issue) => issue.line)).toEqual([1, 6]);
    });

    test("closes only on a fence at least as long as its opener", () => {
      // Four backticks open; three are content, not a close.
      const content = "````\n```\n````\ncoffee; cup\n";
      expect(proseBlocks(content).map((line) => line.text)).toEqual([
        "coffee; cup",
      ]);
    });

    test("a typed fence inside an open block is code, not a close", () => {
      // `` ```ts `` carries an info string, so it cannot close the block it
      // sits in; prose after the true closer still reads.
      const content = "```\ncode\n```ts\nalso code\n```\na;\n";
      expect(proseBlocks(content).map((line) => line.text)).toEqual(["a;"]);
    });

    test("a typed fence opens when no block is open", () => {
      const content = "a;\n```ts\ncode\n```\nb;\n";
      expect(findIssues(content).map((issue) => issue.line)).toEqual([1, 5]);
    });

    testCases(
      [
        [
          "keeps reading prose after an indented block closes",
          ["    code; here\nProse; after.\n"],
          ["semicolon"],
        ],
        [
          "keeps reading an indented line that continues a list item",
          ["- One item\n    Should retry now.\n"],
          ["banned-modal"],
        ],
        [
          "never reads code spans of two or more backticks",
          [
            "Use ``should`` here.",
            "Use ```would``` here.",
            // A run closes only on a run of the same length.
            "Use ` ``should` here.",
          ],
          [],
        ],
        [
          "leaves a quoted span after a colon alone",
          ['The write fails: "wasn\'t finalized".'],
          [],
        ],
        [
          "leaves a quoted span after error or message alone",
          [
            'The error "row locked" repeats.',
            'The message "row locked" repeats.',
          ],
          [],
        ],
        [
          "leaves a quoted span the noun links through e.g. alone",
          [
            'The error sentence — e.g. "its secrets can\'t be read".',
            // The em-dash and the token's case change nothing.
            'The ERROR sentence — E.g. "its secrets can\'t be read".',
            'The error sentence — E.G. "its secrets can\'t be read".',
          ],
          [],
        ],
        [
          "judges a quotation that e.g. introduces without the noun",
          ['See e.g. "should retry" now.'],
          ["wordy", "banned-modal"],
        ],
        [
          "judges a quotation behind any other linking word",
          ['The error is "should retry".', 'The message reads "should retry".'],
          ["banned-modal"],
        ],
        [
          "judges a quotation when a quote sits between noun and e.g.",
          ['The error note "row locked" and e.g. "should retry".'],
          ["wordy", "banned-modal"],
        ],
        [
          "leaves a quoted span inside a thrown error alone",
          [
            'The call throws new Error("it should not happen").',
            'The call throws new Error(read(x), "it should not happen").',
          ],
          [],
        ],
        [
          "judges a quote after a completed error constructor",
          ['Use new Error(code) before saying "the path should retry".'],
          ["banned-modal"],
        ],
        [
          "keeps an escaped quote inside an exempt message",
          ['The error "The \\"should\\" value failed" repeats.'],
          [],
        ],
      ],
      rulesOn,
    );
  });

  describe("each rule", () => {
    testCases(
      [
        [
          "judges the words inside a quoted span of prose",
          ['The path "should retry" after failure.', 'Say "would" here.'],
          ["banned-modal"],
        ],
        [
          "contraction flags pronoun short forms and every n't",
          ["It's fine. It isn't here. You're done. We've got it."],
          ["contraction", "contraction", "contraction", "contraction"],
        ],
        [
          "contraction leaves a possessive noun alone",
          ["The site's name stays."],
          [],
        ],
        [
          "contraction flags the 'd short form of a modal",
          ["They'd retry. We'd stop."],
          ["contraction", "contraction"],
        ],
        [
          "present-perfect flags has, have, and had been",
          ["The column has been added.", "The columns have been added."],
          ["present-perfect"],
        ],
        [
          "present-perfect flags an irregular participle after has, have, or had",
          [
            "Load the other bookings this contact has made.",
            "The gate has seen no traffic.",
            "We have done this twice.",
            "She had written the plan.",
            "The site has had downtime.",
          ],
          ["present-perfect"],
        ],
        [
          "present-perfect flags a regular -ed participle",
          [
            "The form has completed the run.",
            "We have finished the list.",
            "The gate had decided the order.",
          ],
          ["present-perfect"],
        ],
        [
          "present-perfect leaves a noun after had alone",
          [
            "The operator had breakfast first.",
            "The form had a second field.",
            "The plan had two options.",
          ],
          [],
        ],
        [
          "present-perfect leaves an -ed word that is not a participle",
          [
            "The fix has indeed landed.",
            "The count has hundred entries.",
            "The rites have sacred meaning.",
            "The rooms had bed spaces.",
          ],
          [],
        ],
        [
          "present-perfect leaves a participle that heads a compound",
          [
            "The line has required-child edges.",
            "The form has built-in checks.",
          ],
          [],
        ],
        [
          "banned-modal flags a sentence-initial Should, Would, or Could",
          [
            "Should the test fail, read the log.",
            "Would this work?",
            "Could this work?",
          ],
          ["banned-modal"],
        ],
        [
          "banned-modal leaves May the month alone",
          ["The deploy runs in May."],
          [],
        ],
        [
          "banned-modal leaves the inside of a word alone",
          ["The mightiest shield."],
          [],
        ],
        [
          "semicolon flags a semicolon in prose",
          ["Write two; not one."],
          ["semicolon"],
        ],
        [
          "participle flags a comma plus one -ing clause word",
          ["Run it, making it easy.", "Run it, allowing more."],
          ["participle"],
        ],
        [
          "participle flags every clause on a line, not only the first",
          ["Run it, making it easy, hiding the cost."],
          ["participle", "participle"],
        ],
        [
          "participle leaves a sentence without the pattern alone",
          ["Run it and make it easy."],
          [],
        ],
      ],
      rulesOn,
    );

    test("banned-modal flags the modals the guide bans", () => {
      expect(
        ["Run it. It should work and it could fail.", "It may fail."].map(
          rulesOn,
        ),
      ).toEqual([["banned-modal", "banned-modal"], ["banned-modal"]]);
    });

    test("wordy flags each banned word with its own fix", () => {
      const issues = issuesOn("Prior to this, in order to run it.");
      expect(issues.map((issue) => issue.problem)).toEqual([
        '"Prior to"',
        '"in order to"',
      ]);
      expect(issues[0]!.fix).toBe('write "before"');
      expect(issues[1]!.fix).toBe('write "to"');
    });

    test("wordy flags e.g. with periods, but not inside a longer word", () => {
      expect([
        rulesOn("Run it, e.g. now."),
        rulesOn("Utilized text stays."),
      ]).toEqual([["wordy"], []]);
    });
  });
});
