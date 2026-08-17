import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CommentIssue,
  type CommentLimits,
  findCommentIssues,
  formatIssue,
  readComments,
} from "#scripts/check-comments/rules.ts";

const LIMITS: CommentLimits = { maxColumns: 40, maxLines: 3 };

const rules = (source: string, limits: CommentLimits = LIMITS): string[] =>
  findCommentIssues(source, limits).map((issue) => issue.rule);

/** The one issue `source` should raise, failing loudly when it raises none. */
const onlyIssue = (
  source: string,
  limits: CommentLimits = LIMITS,
): CommentIssue => {
  const [issue] = findCommentIssues(source, limits);
  if (!issue) throw new Error(`expected an issue for: ${source}`);
  return issue;
};

describe("readComments", () => {
  test("finds a line comment and a block comment", () => {
    const found = readComments("// one\nconst a = 1;\n/* two */\n");
    expect(found).toEqual([
      { column: 0, line: 1, text: "// one" },
      { column: 0, line: 3, text: "/* two */" },
    ]);
  });

  test("reports the line a comment opens on, not the file start", () => {
    const found = readComments("const a = 1;\n\n\n// here\n");
    expect(found).toEqual([{ column: 0, line: 4, text: "// here" }]);
  });

  test("ignores a comment marker inside a string", () => {
    expect(readComments('const url = "https://example.com/a";\n')).toEqual([]);
  });

  test("ignores a comment marker inside a template literal", () => {
    expect(readComments("const a = `/* not a comment */`;\n")).toEqual([]);
  });

  test("drops directives, which a tool reads rather than a person", () => {
    const source = [
      "/* jscpd:ignore-start */",
      '/// <reference lib="dom" />',
      "// deno-lint-ignore no-explicit-any",
      "// biome-ignore lint: needed",
      "// @ts-expect-error deliberate",
      "// test-groups: run-alone",
      "// kept",
    ].join("\n");
    expect(readComments(source)).toEqual([
      { column: 0, line: 7, text: "// kept" },
    ]);
  });

  test("keeps a comment that merely mentions a directive-like word", () => {
    const found = readComments("// prefer a named type over a cast\n");
    expect(found).toHaveLength(1);
  });
});

describe("comment-length rule", () => {
  test("passes a comment exactly at the limit", () => {
    expect(rules("/**\n * a\n */\n")).toEqual([]);
  });

  test("flags a comment one line over the limit", () => {
    expect(rules("/**\n * a\n * b\n */\n")).toEqual(["comment-length"]);
  });

  test("counts the lines it found and the limit it broke", () => {
    const issue = onlyIssue("/**\n * a\n * b\n */\n");
    expect(issue.problem).toBe("comment runs 4 lines (limit 3)");
    expect(issue.line).toBe(1);
  });

  test("counts consecutive line comments separately, not as one block", () => {
    expect(rules("// a\n// b\n// c\n// d\n// e\n")).toEqual([]);
  });

  test("respects the configured limit rather than a fixed one", () => {
    const source = "/**\n * a\n * b\n */\n";
    expect(rules(source, { maxColumns: 40, maxLines: 4 })).toEqual([]);
    expect(rules(source, { maxColumns: 40, maxLines: 2 })).toEqual([
      "comment-length",
    ]);
  });
});

describe("comment-width rule", () => {
  test("passes a comment exactly at the limit", () => {
    expect(rules(`// ${"a".repeat(37)}\n`)).toEqual([]);
  });

  test("flags a comment one column over the limit", () => {
    expect(rules(`// ${"a".repeat(38)}\n`)).toEqual(["comment-width"]);
  });

  test("counts what precedes a trailing comment on its own line", () => {
    // A comment after code starts at that code's end, so its width is measured
    // from there — not from the line's indent, which is 0 here.
    const source = `const a = 1; // ${"z".repeat(27)}`;
    expect(source).toHaveLength(43);
    expect(rules(source)).toEqual(["comment-width"]);
    expect(onlyIssue(source).problem).toBe(
      "comment line is 43 columns (limit 40)",
    );
  });

  test("counts the indent of the line the comment opens on", () => {
    // 36 characters of comment sits under the 40-column limit on its own, and
    // over it once the eight-space indent is counted.
    const comment = `// ${"a".repeat(33)}`;
    expect(comment).toHaveLength(36);
    expect(rules(`${comment}\n`)).toEqual([]);
    expect(rules(`        ${comment}\n`)).toEqual(["comment-width"]);
  });

  test("reports the widest line inside a block, not the first", () => {
    const source = `/**\n * short\n * ${"b".repeat(45)}\n */\n`;
    const issue = onlyIssue(source, { maxColumns: 40, maxLines: 10 });
    expect(issue.rule).toBe("comment-width");
    expect(issue.line).toBe(3);
    expect(issue.problem).toBe("comment line is 48 columns (limit 40)");
  });

  test("does not add the opening indent to a continuation line", () => {
    // The continuation line already carries its own leading spaces, so adding
    // the opener's indent again would double-count it.
    const source = `    /**\n     * ${"b".repeat(20)}\n     */\n`;
    expect(findCommentIssues(source, { maxColumns: 40, maxLines: 10 })).toEqual(
      [],
    );
  });
});

describe("findCommentIssues", () => {
  test("reports both rules when one comment breaks both", () => {
    const source = `/**\n * ${"a".repeat(60)}\n * b\n * c\n */\n`;
    expect(rules(source).sort()).toEqual(["comment-length", "comment-width"]);
  });

  test("returns nothing for a file with no comments", () => {
    expect(findCommentIssues("const a = 1;\n", LIMITS)).toEqual([]);
  });

  test("never flags a directive, however long or wide", () => {
    const source = `// biome-ignore lint: ${"a".repeat(200)}\n`;
    expect(findCommentIssues(source, LIMITS)).toEqual([]);
  });

  test("orders issues by where they appear in the file", () => {
    const source = `// ${"a".repeat(50)}\nconst a = 1;\n// ${"b".repeat(50)}\n`;
    expect(findCommentIssues(source, LIMITS).map((i) => i.line)).toEqual([
      1, 3,
    ]);
  });
});

describe("formatIssue", () => {
  test("names the file, the line, the problem, and the fix", () => {
    const issue = onlyIssue("/**\n * a\n * b\n */\n");
    expect(formatIssue("src/a.ts", issue)).toBe(
      "src/a.ts:1  comment runs 4 lines (limit 3)\n    Say only what the code cannot, or give the confusing part a name that carries the explanation.",
    );
  });
});
