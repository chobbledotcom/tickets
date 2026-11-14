/**
 * Detectors for the SQL tag rule: SQL is written only in a `sql` template, and
 * a value is written only in a slot. The types refuse a bare string at the
 * runners. These detectors refuse the ways around the types. The live
 * assertion sits in `test/integration/code-quality.test.ts`. The crafted
 * fixtures sit in `./sql-tag.test.ts`.
 */

import { requiredMapValue } from "#fp";
import { interpolationEnd, lexicalSpans } from "#scripts/typescript-lex.ts";

/** The module that makes statements. */
const SQL_TAG_PATH = "shared/db/sql.ts";

/** The modules that can name the restore boundary. */
const DUMP_TEXT_PATHS = new Set([SQL_TAG_PATH, "shared/db/backup.ts"]);

/** Text that starts as a statement SQLite runs. */
const STATEMENT_START =
  /^\s*(?:SELECT\s[\s\S]*\sFROM\s|INSERT\s+(?:OR\s+\w+\s+)?INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|(?:CREATE|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s|ALTER\s+TABLE\s|PRAGMA\s+\w)/;

/** A placeholder after an operator, a bracket or a comma. */
const PLACEHOLDER =
  /(?:[=<>(,]|\b(?:IN|LIKE|IS|THEN|ELSE|LIMIT|OFFSET))\s*\?\d*(?=[\s,);]|$)/;

/** A string span of one file, in absolute positions. */
type Span = { end: number; start: number };

/** The one-based line an index sits on. */
const lineAt = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

/** Whether the template at `start` carries the `sql` tag. */
const hasSqlTag = (content: string, start: number): boolean =>
  content[start] === "`" && /(?<![\w$.])sql$/.test(content.slice(0, start));

/** The interpolations of one template, as the positions of their code. */
const interpolationsOf = (content: string, span: Span): Span[] => {
  const found: Span[] = [];
  let at = span.start + 1;
  while (at < span.end - 1) {
    if (content[at] === "\\") {
      at += 2;
      continue;
    }
    if (content[at] === "$" && content[at + 1] === "{") {
      const close = interpolationEnd(content, at + 2);
      found.push({ end: close, start: at + 2 });
      at = close + 1;
      continue;
    }
    at += 1;
  }
  return found;
};

/** The text of one string span that is not interpolation code. */
const ownText = (content: string, span: Span): string => {
  if (content[span.start] !== "`") {
    return content.slice(span.start + 1, span.end - 1);
  }
  let text = "";
  let at = span.start + 1;
  for (const hole of interpolationsOf(content, span)) {
    text += `${content.slice(at, hole.start - 2)} `;
    at = hole.end + 1;
  }
  return text + content.slice(at, span.end - 1);
};

/** SQL text with each quoted literal blanked: a `?` inside `'enc:1:?*'` is
 * data, not a placeholder. */
const withoutQuotedLiterals = (text: string): string =>
  text.replaceAll(/'(?:[^']|'')*'/g, "''");

/** The string spans one span's interpolations hold, at every depth. */
const spansInside = (content: string, span: Span): Span[] =>
  content[span.start] !== "`"
    ? []
    : interpolationsOf(content, span).flatMap((hole) =>
        [...lexicalSpans(content.slice(hole.start, hole.end))]
          .filter((inner) => inner.kind === "string")
          .map((inner) => ({
            end: hole.start + inner.end,
            start: hole.start + inner.start,
          })),
      );

/** What is wrong with one string span, or null. */
const spanProblem = (
  content: string,
  span: Span,
  plainSqlAllowed: boolean,
): string | null => {
  const text = ownText(content, span);
  if (hasSqlTag(content, span.start)) {
    return withoutQuotedLiterals(text).includes("?")
      ? "a sql template spells a placeholder; write the value in a slot"
      : null;
  }
  if (plainSqlAllowed) return null;
  if (STATEMENT_START.test(text)) {
    return "SQL text sits in a plain string; write it in a sql template";
  }
  if (PLACEHOLDER.test(withoutQuotedLiterals(text))) {
    return "a plain string spells a SQL placeholder; write the SQL in a sql template";
  }
  return null;
};

/** The problems of one span and of the strings its interpolations hold. */
const spanProblems = (
  relativePath: string,
  content: string,
  span: Span,
  plainSqlAllowed: boolean,
): string[] => {
  const problem = spanProblem(content, span, plainSqlAllowed);
  return [
    ...(problem === null
      ? []
      : [`${relativePath}:${lineAt(content, span.start)}: ${problem}`]),
    ...spansInside(content, span).flatMap((inner) =>
      spanProblems(relativePath, content, inner, plainSqlAllowed),
    ),
  ];
};

/** The code of one file with comments, strings and regexes left out. */
const codeOnly = (content: string): { at: number; text: string }[] => {
  const parts: { at: number; text: string }[] = [];
  let at = 0;
  for (const span of lexicalSpans(content)) {
    parts.push({ at, text: content.slice(at, span.start) });
    at = span.end;
  }
  parts.push({ at, text: content.slice(at) });
  return parts;
};

/** The places in code where `pattern` matches, as one finding each. */
const codeFindings = (
  relativePath: string,
  content: string,
  pattern: RegExp,
  problem: string,
): string[] =>
  codeOnly(content).flatMap((part) =>
    [...part.text.matchAll(pattern)].map(
      (match) =>
        `${relativePath}:${lineAt(content, part.at + match.index)}: ${problem}`,
    ),
  );

/** The SQL tag violations of one source file. A file that writes SQL text
 * for a reader other than the database can hold plain SQL strings. */
export const findSqlTagViolations = (
  relativePath: string,
  content: string,
  plainSqlAllowed = false,
): string[] => {
  if (relativePath === SQL_TAG_PATH) return [];
  return [
    ...[...lexicalSpans(content)]
      .filter((span) => span.kind === "string")
      .flatMap((span) =>
        spanProblems(relativePath, content, span, plainSqlAllowed),
      ),
    ...codeFindings(
      relativePath,
      content,
      /\bas\s+(?:unknown\s+as\s+)?SqlStatement\b/g,
      "a cast makes a statement; only the sql tag makes one",
    ),
    ...(DUMP_TEXT_PATHS.has(relativePath)
      ? []
      : codeFindings(
          relativePath,
          content,
          /\bsqlFromDump\b/g,
          "sqlFromDump is for backup restore only",
        )),
  ];
};

/** The violations of the SQL tag rule over one loaded source tree.
 * `toRelative` names each file the way a finding reports it. */
export const findSqlTagViolationsIn = (
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
  toRelative: (file: string) => string,
  plainSqlFiles: readonly string[],
): string[] =>
  files.flatMap((file) =>
    findSqlTagViolations(
      toRelative(file),
      requiredMapValue(contents, file, `Missing source text for ${file}`),
      plainSqlFiles.includes(toRelative(file)),
    ),
  );
