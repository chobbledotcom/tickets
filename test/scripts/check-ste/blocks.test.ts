import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findIssues } from "#scripts/check-ste/rules.ts";
import { baselineRose, freshEntry } from "#scripts/check-ste/run.ts";

describe("STE Markdown block contract", () => {
  test("finds phrases across soft wraps at their source line", () => {
    expect(
      findIssues(
        "The change has\nbeen applied in\norder to help,\nmaking this easy.",
      ).map(({ rule, line, problem }) => ({ line, problem, rule })),
    ).toEqual([
      { line: 1, problem: '"has been"', rule: "present-perfect" },
      { line: 2, problem: '"in order to"', rule: "wordy" },
      { line: 3, problem: '", making"', rule: "participle" },
    ]);
  });

  test("does not join distinct prose blocks", () => {
    for (const content of [
      "It has\n\nbeen done.",
      "# It has\nbeen done.",
      "- It has\n- been done.",
      "It has\n\n> been done.",
      'Say "example\n\nIt should fail.\n\nend".',
    ]) {
      expect(findIssues(content).map(({ rule }) => rule)).toEqual(
        content.includes("should") ? ["banned-modal"] : [],
      );
    }
  });

  test("quotes inside excluded code cannot conceal later prose", () => {
    for (const content of [
      '```\n"\n```\nIt should fail.\n```\n"\n```',
      '`"` It should fail. `"`',
      '> ```\n> "\n> ```\n> It should fail.\n> ```\n> "\n> ```',
    ]) {
      expect(findIssues(content).map(({ problem }) => problem)).toEqual([
        '"should"',
      ]);
    }
  });

  test("code fences do not conceal earlier prose quotes", () => {
    const content = 'Say "example\n```\n"\n```\nIt should fail.';
    expect(findIssues(content).map(({ line }) => line)).toEqual([5]);
  });

  test("reads container prose but not container code or real tables", () => {
    expect(
      findIssues(
        [
          "> Text has",
          "> been done.",
          ">",
          "> ```",
          "> should; code",
          "> ```",
          "",
          "- One item",
          "",
          "  It should fail.",
          "",
          "      code; should",
          "",
          "left | right",
          "--- | ---",
          "should | would",
          "",
          "| Ordinary prose should fail.",
        ].join("\n"),
      ).map(({ problem, line }) => [problem, line]),
    ).toEqual([
      ['"has been"', 1],
      ['"should"', 10],
      ['"should"', 18],
    ]);
  });

  test("keeps prose around multiline inline code and comments", () => {
    const content =
      "Use `code\nshould` but should fail. <!-- hidden\nshould --> It could fail.";
    expect(
      findIssues(content).map(({ problem, line }) => [problem, line]),
    ).toEqual([
      ['"should"', 2],
      ['"could"', 3],
    ]);
    expect(
      findIssues("It has `code` been done. It has <!-- note --> been done."),
    ).toEqual([]);
  });

  test("reads formatted text and link labels but not destinations", () => {
    expect(
      findIssues(
        "It **has**\nbeen done. [It should fail](https://example.com/should).",
      ).map(({ problem }) => problem),
    ).toEqual(['"has been"', '"should"']);
    expect(
      findIssues(
        '[See docs][ref]\n\n[ref]: https://example.com/should "would"',
      ),
    ).toEqual([]);
  });

  test("excludes quoted examples only within eligible prose", () => {
    expect(
      findIssues('Say "It should\nfail". It could fail.').map(
        ({ problem }) => problem,
      ),
    ).toEqual(['"could"']);
    expect(findIssues('Say "has `x` been".')).toEqual([]);
  });

  test("keeps allowances stable under soft wraps and exempt span lengths", () => {
    const before = freshEntry('It should use `x` and "bad example" now.');
    expect(
      freshEntry('It should\nuse `long code` and "another long example" now.'),
    ).toEqual(before);
    expect(
      baselineRose(
        { "a.md": before },
        {
          "a.md": freshEntry('It should use `x` and "bad example" elsewhere.'),
        },
      ),
    ).toBe(true);
  });

  test("flags the named filler phrase and unambiguous contractions", () => {
    expect(
      findIssues("It is worth\nnoting. Here's where's how's This'll.").map(
        ({ problem }) => problem,
      ),
    ).toEqual([
      '"It is worth noting"',
      '"Here\'s"',
      '"where\'s"',
      '"how\'s"',
      '"This\'ll"',
    ]);
  });

  test("does not transfer a code allowance to literal placeholder prose", () => {
    const recorded = { "a.md": freshEntry("It should use `value`.") };
    expect(
      baselineRose(recorded, { "a.md": freshEntry("It should use %.") }),
    ).toBe(true);
  });

  test("keeps source columns after nested markup and exempt spans", () => {
    expect(
      findIssues(
        '> - Say "long example". It should fail.\r\n>   It could fail.',
      ).map(({ line, column, problem }) => ({ column, line, problem })),
    ).toEqual([
      { column: 28, line: 1, problem: '"should"' },
      { column: 8, line: 2, problem: '"could"' },
    ]);
  });

  test("keeps image labels as prose", () => {
    expect(
      findIssues("![It could fail](https://example.com)").map(
        ({ problem }) => problem,
      ),
    ).toEqual(['"could"']);
  });

  test("reads nested lists with tabs", () => {
    expect(
      findIssues("- First\n\t- It should fail.\n\t\tIt could fail.").map(
        ({ line, problem }) => [line, problem],
      ),
    ).toEqual([
      [2, '"should"'],
      [3, '"could"'],
    ]);
  });

  test("reads prose around inline markup the machine owns", () => {
    expect(
      findIssues(
        [
          "Escape \\*It could fail\\* now.",
          "Visit <https://example.com/should> and should fail.",
          "<span>It could fail too.</span>",
          "Hard\\\nbreak could fail.",
          "Setext\n======\n\nIt might fail.",
        ].join("\n"),
      ).map(({ line, problem }) => [problem, line]),
    ).toEqual([
      ['"could"', 1],
      ['"should"', 2],
      ['"could"', 3],
      ['"could"', 5],
      ['"might"', 9],
    ]);
  });

  test("reads a task list's text but not its checkbox marker", () => {
    expect(
      findIssues("- [x] It should fail.\n- [ ] It could fail.").map(
        ({ line, problem }) => [problem, line],
      ),
    ).toEqual([
      ['"should"', 1],
      ['"could"', 2],
    ]);
  });

  test("skips the block html but reads the prose around it", () => {
    expect(
      findIssues(
        "<div>should stay hidden</div>\n\nIt should fail.\n\n<p>would too</p>",
      ).map(({ line, problem }) => [problem, line]),
    ).toEqual([['"should"', 3]]);
  });

  test("an empty heading still reads as one block", () => {
    expect(
      findIssues("#\n\nIt should fail.").map(({ problem }) => problem),
    ).toEqual(['"should"']);
  });
});
