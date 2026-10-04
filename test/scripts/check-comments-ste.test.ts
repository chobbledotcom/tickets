import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findCommentSteIssues,
  MAX_SENTENCE_WORDS,
} from "#scripts/check-comments/ste.ts";

/** The rules one comment raises, failing loudly when it raises none. */
const rulesOf = (comment: string): string[] => {
  const rules = findCommentSteIssues(comment).map(({ rule }) => rule);
  if (rules.length === 0) throw new Error(`expected a finding for: ${comment}`);
  return rules;
};

const sentenceOf = (words: number): string =>
  Array.from({ length: words }, (_, index) => `word${index + 1}`).join(" ");

/** The one banned-modal finding a comment raises, failing loudly when it
 * raises none. */
const findsOne = (comment: string, rule: string, line: number): void => {
  const issues = findCommentSteIssues(comment);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.rule).toBe(rule);
  expect(issues[0]!.line).toBe(line);
};

describe("comment language rules", () => {
  test("flags the mechanical patterns by rule name", () => {
    expect(rulesOf("// We don't ship this yet.")).toContain("contraction");
    expect(rulesOf("// The form should save itself.")).toContain(
      "banned-modal",
    );
    expect(rulesOf("// Load the row; then act.")).toContain("semicolon");
    expect(rulesOf("// The row saves, allowing a retry.")).toContain(
      "participle",
    );
    expect(rulesOf("// The row has been saved.")).toContain("present-perfect");
    expect(rulesOf("// The check simply passes.")).toContain("wordy");
  });

  test("leaves a possessive alone", () => {
    expect(() => rulesOf("// The listing's own price applies.")).toThrow();
  });

  test("leaves a backticked span alone", () => {
    expect(() => rulesOf("// The marker is `don't ship`.")).toThrow();
  });

  test("leaves a double-quoted message alone", () => {
    expect(() =>
      rulesOf('// The write refuses with "wasn\'t finalized".'),
    ).toThrow();
  });

  test("leaves a camelCase name that starts with a banned modal alone", () => {
    expect(() => rulesOf("// The helper shouldRetry twice.")).toThrow();
  });

  test("finds a pattern wrapped across block-comment lines", () => {
    // "has been" spans two JSDoc lines, so a per-line match would miss it.
    expect(rulesOf("/**\n * The row has\n * been saved.\n */")).toContain(
      "present-perfect",
    );
  });

  test("finds a phrase wrapped across neighbouring line comments", () => {
    expect(rulesOf("// Do this in\n// order to proceed.")).toContain("wordy");
  });

  test("finds a participle whose comma ends the line above", () => {
    expect(rulesOf("// The row saves,\n// allowing a retry.")).toContain(
      "participle",
    );
  });

  test("flags a sentence past the word limit and names its length", () => {
    const issue = findCommentSteIssues(
      `/** ${sentenceOf(MAX_SENTENCE_WORDS + 1)}. */`,
    );
    expect(issue).toHaveLength(1);
    expect(issue[0]!.rule).toBe("long-sentence");
    expect(issue[0]!.problem).toBe(`${MAX_SENTENCE_WORDS + 1}-word sentence`);
  });

  test("holds a sentence wrapped across block lines to the limit", () => {
    // The sentence spans three JSDoc lines; splitting per line would hide it.
    const issue = findCommentSteIssues(`/**
 * ${sentenceOf(MAX_SENTENCE_WORDS + 1)}.
 */`);
    expect(issue).toHaveLength(1);
  });

  test("holds a sentence wrapped across line comments to the limit", () => {
    // Consecutive // comments are one prose block, so the wrapped sentence
    // counts as the one sentence it is.
    const issue = findCommentSteIssues(
      `// ${sentenceOf(MAX_SENTENCE_WORDS - 2)}\n// and three more words.`,
    );
    expect(issue).toHaveLength(1);
    expect(issue[0]!.line).toBe(1);
  });

  test("code between line comments keeps their sentences apart", () => {
    const issues = findCommentSteIssues(
      `// ${sentenceOf(MAX_SENTENCE_WORDS - 5)}\ncode();\n// ${sentenceOf(MAX_SENTENCE_WORDS - 5)}`,
    );
    expect(issues).toHaveLength(0);
  });

  test("attribution names the line the sentence starts on", () => {
    const issue = findCommentSteIssues(`/**
 * A heading line.
 *
 * ${sentenceOf(MAX_SENTENCE_WORDS + 1)}.
 */`);
    expect(issue).toHaveLength(1);
    expect(issue[0]!.line).toBe(4);
  });

  test("a sentence at the limit is not a finding", () => {
    expect(
      findCommentSteIssues(`/** ${sentenceOf(MAX_SENTENCE_WORDS)}. */`),
    ).toHaveLength(0);
  });

  test("a bare block-comment closer adds no word to the last sentence", () => {
    // The closer's slash used to survive as a 26th word.
    expect(
      findCommentSteIssues(`/**\n * ${sentenceOf(MAX_SENTENCE_WORDS)}\n */`),
    ).toHaveLength(0);
  });

  test("a fenced code block is not prose", () => {
    const issues = findCommentSteIssues(`/**
 * The gate should stay off by default.
 *
 * \`\`\`js
 * const config = shouldRetryWithBackoff(pending, ${sentenceOf(30)});
 * \`\`\`
 *
 * A closing don't below the fence is still prose.
 */`);
    expect(issues.map(({ line, rule }) => [line, rule])).toEqual([
      [2, "banned-modal"],
      [8, "contraction"],
    ]);
  });

  test("a fence stays closed across neighbouring line comments", () => {
    findsOne(
      "// ```ts\n// const config = shouldRetry(pending);\n// ```\n// A closing don't after the fence.",
      "contraction",
      4,
    );
  });

  test("a fence with trailing text does not close", () => {
    // ```example is fence text in Markdown, not a closing marker, so the
    // lines after it stay inside the fence.
    expect(
      findCommentSteIssues(
        "// ```ts\n// const value = 1;\n// ```example\n// don't trust this line.",
      ),
    ).toHaveLength(0);
  });

  test("code between comments ends an open fence", () => {
    findsOne(
      "// ```ts\nconst code = 1;\n// The form should save.",
      "banned-modal",
      3,
    );
  });

  test("an indented code block inside a comment is not prose", () => {
    expect(
      findCommentSteIssues("// Example:\n//\n//     const value = 1;"),
    ).toHaveLength(0);
  });

  test("an example carries across neighbouring line comments", () => {
    const issues = findCommentSteIssues(
      "// @example\n//\n// const value = 1;\n//\n// @returns the opened resource, giving it back after use",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe("participle");
    expect(issues[0]!.line).toBe(5);
  });

  test("a comment that only mentions a directive is prose", () => {
    findsOne(
      "// Remove @ts-ignore because this should compile.",
      "banned-modal",
      1,
    );
  });

  test("a star list's items hold their sentences separately", () => {
    const issues = findCommentSteIssues(
      `/**\n * * ${sentenceOf(MAX_SENTENCE_WORDS)}\n * * ${sentenceOf(MAX_SENTENCE_WORDS + 3)}\n */`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.problem).toBe(`${MAX_SENTENCE_WORDS + 3}-word sentence`);
  });

  test("two comments on one line are separate prose blocks", () => {
    expect(
      findCommentSteIssues("/* It has */ save(); /* been stopped. */"),
    ).toHaveLength(0);
  });

  test("a JSDoc tag's own token is not a word of its description", () => {
    expect(
      findCommentSteIssues(
        `/**\n * @returns ${sentenceOf(MAX_SENTENCE_WORDS)}.\n */`,
      ),
    ).toHaveLength(0);
  });

  test("a JSDoc tag's argument is not a word of its description", () => {
    expect(
      findCommentSteIssues(
        `/**\n * @param attendee ${sentenceOf(MAX_SENTENCE_WORDS)}.\n */`,
      ),
    ).toHaveLength(0);
  });

  test("a four-backtick fence closes only at its own marker", () => {
    const issues = findCommentSteIssues(
      "// ````ts\n// const value = shouldRetry;\n// ```\n// don't trust this line.\n// ````",
    );
    expect(issues).toHaveLength(0);
  });

  test("a tilde fence ends when code separates comments", () => {
    findsOne(
      "// ~~~\n// const value = 1;\ncode();\n// The form should save.",
      "banned-modal",
      4,
    );
  });

  test("a spaced dash is not a word", () => {
    const issues = findCommentSteIssues(
      `// ${sentenceOf(MAX_SENTENCE_WORDS - 1)} — more.`,
    );
    expect(issues).toHaveLength(0);
  });

  test("code on the comment's own line ends an open fence", () => {
    findsOne("// ```ts\ncode(); // The form should save.", "banned-modal", 2);
  });

  test("neighbouring block comments hold separate sentences", () => {
    expect(
      findCommentSteIssues("/* It has */\n/* been stopped. */"),
    ).toHaveLength(0);
  });

  test("an abbreviation's period does not end a sentence", () => {
    const issues = findCommentSteIssues(
      `// Load the rows, the groups, the bookings, the listings, and the settings etc. ${sentenceOf(MAX_SENTENCE_WORDS)} flow.`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe("long-sentence");
  });

  test("a tag inside a fence leaves no example state behind", () => {
    findsOne(
      "// ```ts\n// @example\n// ```\n// The form should save.",
      "banned-modal",
      4,
    );
  });

  test("a block comment's example ends with its closer", () => {
    findsOne(
      "/**\n * @example\n * const value = 1;\n */\n// The form should save.",
      "banned-modal",
      5,
    );
  });

  test("a line comment after a block comment holds its own sentences", () => {
    expect(
      findCommentSteIssues("/* It has */\n// been stopped. */"),
    ).toHaveLength(0);
  });

  test("an indented fence marker opens and ends its fence", () => {
    findsOne(
      "//   ```ts\ncode();\n// The form should save.",
      "banned-modal",
      3,
    );
  });

  test("a block comment starts fresh behind a blanked fence row", () => {
    findsOne("// ```ts\n/** The form should save. */", "banned-modal", 2);
  });

  test("a nested JSDoc type argument is not prose", () => {
    expect(
      findCommentSteIssues(
        `/**\n * @param {{label: string}} options ${sentenceOf(MAX_SENTENCE_WORDS)}.\n */`,
      ),
    ).toHaveLength(0);
  });

  test("a tag's type is not a word of its description", () => {
    expect(
      findCommentSteIssues(
        `/**\n * @returns {boolean} ${sentenceOf(MAX_SENTENCE_WORDS)}.\n */`,
      ),
    ).toHaveLength(0);
  });

  test("an indented closer ends an indented fence", () => {
    findsOne(
      "//   ```ts\n// const value = 1;\n//   ```\n// don't trust this line.",
      "contraction",
      4,
    );
  });

  test("prose before a directive line is still prose", () => {
    findsOne(
      "/**\n * We should retry.\n * biome-ignore lint/x/y: reason\n */",
      "banned-modal",
      2,
    );
  });

  test("line-comment bullets keep their own blocks", () => {
    // The `*` after the `//` is a bullet marker, not comment gutter, so the
    // two entries stay two blocks and their words never add up.
    expect(
      findCommentSteIssues(
        `// * ${sentenceOf(MAX_SENTENCE_WORDS - 4)}\n// * ${sentenceOf(MAX_SENTENCE_WORDS - 4)}`,
      ),
    ).toHaveLength(0);
  });

  test("an example body is not prose, the tags around it are", () => {
    const issues = findCommentSteIssues(`/**
 * Frees the resource even when the work throws.
 *
 * @example
 * const withConnection = bracket(
 *   () => openConnection(),
 *   (conn) => conn.close()
 * );
 * const result = await withConnection(async (conn) => conn.query('SELECT 1'));
 *
 * @returns the opened resource, giving it back after use
 */`);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe("participle");
    expect(issues[0]!.line).toBe(11);
  });

  test("a bullet's marker is not a word, its sentence is still held", () => {
    const issue = findCommentSteIssues(
      `// - ${sentenceOf(MAX_SENTENCE_WORDS + 1)}.`,
    );
    expect(issue).toHaveLength(1);
    expect(issue[0]!.problem).toBe(`${MAX_SENTENCE_WORDS + 1}-word sentence`);
  });

  test("a table follows the Markdown rules the policy check uses", () => {
    // A lone row reads as one paragraph, so its words face every rule.
    expect(rulesOf("// | don't |")).toContain("contraction");
    // A real table is not prose: marked leaves its rows out entirely.
    expect(
      findCommentSteIssues(
        `// | should | could |\n// | --- | --- |\n// | ${sentenceOf(MAX_SENTENCE_WORDS + 5)} |`,
      ),
    ).toHaveLength(0);
  });

  test("a directive's explanation is prose, its machine part is not", () => {
    const issues = findCommentSteIssues(
      "// biome-ignore lint/suspicious/noControlCharactersInRegex: don't allow tabs here.",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe("contraction");
    expect(issues[0]!.line).toBe(1);
    expect(
      findCommentSteIssues("/* jscpd:ignore-start -- imports */"),
    ).toHaveLength(0);
  });

  test("findings report in source order across comment kinds", () => {
    // The sentence on line 2 is found after line 3's contraction, so the
    // finder has to sort them back into source order.
    const issues = findCommentSteIssues(`/**
 * ${sentenceOf(MAX_SENTENCE_WORDS + 1)}.
 * and don't stop here.
 */`);
    expect(issues.map(({ line, rule }) => [line, rule])).toEqual([
      [2, "long-sentence"],
      [3, "contraction"],
    ]);
  });
});
