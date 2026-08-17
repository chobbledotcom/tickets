/**
 * Length and width checks for source comments (see "Comments are short" in
 * AGENTS.md). The IO shell that reads the files lives in `run.ts`.
 *
 * This module is pure: source text in, issues out. Both limits exist because
 * neither alone bounds a comment — a one-line comment can still run to 200
 * columns, and eighty short lines still make an essay. Alongside them sits the
 * one correctness check a machine can make here: a `{@link}` naming something
 * that no longer exists.
 */

import { commentSpans } from "#scripts/typescript-lex.ts";

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

/** One comment as written, with where on the page it opens. */
interface SourceComment {
  /** How many characters precede it on its own line. */
  column: number;
  line: number;
  text: string;
}

/** How far `offset` sits from the start of its line. */
const columnOf = (content: string, offset: number): number => {
  let index = offset;
  while (index > 0 && content.charAt(index - 1) !== "\n") index -= 1;
  return offset - index;
};

/**
 * Every comment in a file, directives dropped, in source order. Spans arrive in
 * order, so the line number advances by counting newlines since the last one
 * rather than re-scanning from the top for each.
 */
export const readComments = (content: string): SourceComment[] => {
  const comments: SourceComment[] = [];
  let scanned = 0;
  let line = 1;
  for (const span of commentSpans(content)) {
    line += newlinesBetween(content, scanned, span.start);
    scanned = span.start;
    const text = content.slice(span.start, span.end);
    if (DIRECTIVE.test(text)) continue;
    comments.push({ column: columnOf(content, span.start), line, text });
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
): CommentIssue | null => {
  const { offset, width } = widestLine(comment.text);
  // Only the opening line sits at a column; later lines carry their own indent.
  const columns = offset === 0 ? width + comment.column : width;
  if (columns <= limits.maxColumns) return null;
  return {
    fix: "Shorten the wording rather than rewrapping it.",
    line: comment.line + offset,
    problem: `comment line is ${columns} columns (limit ${limits.maxColumns})`,
    rule: "comment-width",
  };
};

/** A `{@link Target}` reference, capturing the leading name only, so
 *  `{@link Money.total}` is judged on `Money`. The optional `*` lets a link that
 *  wrapped onto the next line of a block still be seen, rather than escaping the
 *  check by being hard to spot. */
const DOC_LINK_RE = /\{@link\s+(?:\*\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;

const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Every name a file mentions outside a doc link. The links are cut out first, so
 * a name that appears only as a link target never vouches for itself — which is
 * what lets a link to a deleted function be spotted.
 */
export const namesMentioned = (content: string): Set<string> =>
  new Set(content.replace(DOC_LINK_RE, " ").match(NAME_RE) ?? []);

/**
 * Doc links pointing at a name that appears nowhere in the scanned tree, which
 * means a rename or delete left the comment behind. Deliberately permissive: a
 * name still mentioned anywhere counts, so only a target with no home at all is
 * reported.
 */
export const findDeadLinks = (
  content: string,
  known: ReadonlySet<string>,
): CommentIssue[] =>
  readComments(content).flatMap((comment) =>
    [...comment.text.matchAll(DOC_LINK_RE)]
      .filter((match) => !known.has(match[1]!))
      .map((match) => ({
        fix: "Point it at the name the code uses now, or drop the link.",
        // A link deep in a block reports its own line, as a wide line does.
        line: comment.line + newlinesBetween(comment.text, 0, match.index),
        problem: `{@link ${match[1]}} names nothing in the tree`,
        rule: "comment-dead-link",
      })),
  );

/** Every limit one file's comments break, ordered by where they appear. */
export const findCommentIssues = (
  content: string,
  limits: CommentLimits,
): CommentIssue[] =>
  readComments(content).flatMap((comment) =>
    [tooLong(comment, limits), tooWide(comment, limits)].filter(
      (issue): issue is CommentIssue => issue !== null,
    ),
  );

/** One issue as a reader-friendly line. */
export const formatIssue = (file: string, issue: CommentIssue): string =>
  `${file}:${issue.line}  ${issue.problem}\n    ${issue.fix}`;
