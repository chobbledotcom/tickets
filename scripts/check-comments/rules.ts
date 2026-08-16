/**
 * Length and width checks for source comments (see "Comments are short" in
 * AGENTS.md). The IO shell that reads the files lives in `run.ts`.
 *
 * This module is pure: source text in, issues out. Both limits exist because
 * neither alone bounds a comment — a one-line comment can still run to 200
 * columns, and eighty short lines still make an essay.
 */

import { lexicalSpans } from "#scripts/typescript-lex.ts";

/** How much comment a file is allowed to carry in one place. */
export interface CommentLimits {
  maxColumns: number;
  maxLines: number;
}

/** One comment that breaks a limit. */
export interface CommentIssue {
  fix: string;
  line: number;
  problem: string;
  rule: string;
}

/**
 * Comments a tool reads rather than a person. Deleting one changes what the
 * build does, so no limit may apply to them.
 */
const DIRECTIVE =
  /jscpd:ignore|<reference|deno-lint-ignore|biome-ignore|@ts-expect-error|@ts-ignore|@ts-nocheck|@ts-self-types|deno-fmt-ignore|test-groups:|sourceMappingURL/;

/** How many newlines `content` holds between `from` and `to`. */
const newlinesBetween = (content: string, from: number, to: number): number => {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (content.charAt(index) === "\n") count += 1;
  }
  return count;
};

/** One comment as written, with the line it opens on. */
interface SourceComment {
  line: number;
  text: string;
}

/**
 * Every comment in a file, directives dropped, in source order. Spans arrive in
 * order, so the line number advances by counting newlines since the last one
 * rather than re-scanning from the top for each.
 */
export const readComments = (content: string): SourceComment[] => {
  const comments: SourceComment[] = [];
  let scanned = 0;
  let line = 1;
  for (const span of lexicalSpans(content)) {
    if (span.kind !== "comment") continue;
    line += newlinesBetween(content, scanned, span.start);
    scanned = span.start;
    const text = content.slice(span.start, span.end);
    if (DIRECTIVE.test(text)) continue;
    comments.push({ line, text });
  }
  return comments;
};

const tooLong = (
  comment: SourceComment,
  limits: CommentLimits,
): CommentIssue | null => {
  const lines = comment.text.split("\n").length;
  if (lines <= limits.maxLines) return null;
  return {
    fix: "Say only what the code cannot, or give the confusing part a name that carries the explanation.",
    line: comment.line,
    problem: `comment runs ${lines} lines (limit ${limits.maxLines})`,
    rule: "comment-length",
  };
};

/**
 * The widest line of a comment, with its offset from the comment's own start,
 * so a wide line deep inside a block reports its own line rather than line one.
 */
const widestLine = (text: string): { offset: number; width: number } => {
  const lines = text.split("\n");
  let offset = 0;
  let width = 0;
  lines.forEach((line, index) => {
    if (line.length > width) {
      width = line.length;
      offset = index;
    }
  });
  return { offset, width };
};

const tooWide = (
  comment: SourceComment,
  limits: CommentLimits,
  indent: number,
): CommentIssue | null => {
  const { offset, width } = widestLine(comment.text);
  // Only the opening line carries the indent; continuation lines include it.
  const columns = offset === 0 ? width + indent : width;
  if (columns <= limits.maxColumns) return null;
  return {
    fix: "Shorten the wording rather than rewrapping it.",
    line: comment.line + offset,
    problem: `comment line is ${columns} columns (limit ${limits.maxColumns})`,
    rule: "comment-width",
  };
};

/** How far the comment opening on `line` is indented. */
const indentOf = (content: string, line: number): number => {
  const text = content.split("\n")[line - 1] ?? "";
  return text.length - text.trimStart().length;
};

/** Every limit one file's comments break, ordered by where they appear. */
export const findCommentIssues = (
  content: string,
  limits: CommentLimits,
): CommentIssue[] =>
  readComments(content).flatMap((comment) => {
    const indent = indentOf(content, comment.line);
    return [tooLong(comment, limits), tooWide(comment, limits, indent)].filter(
      (issue): issue is CommentIssue => issue !== null,
    );
  });

/** One issue as a reader-friendly line. */
export const formatIssue = (file: string, issue: CommentIssue): string =>
  `${file}:${issue.line}  ${issue.problem}\n    ${issue.fix}`;
