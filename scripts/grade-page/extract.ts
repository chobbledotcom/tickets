/**
 * Turn one source page into the facts the grader checks: comments, fallback
 * operators, SQL, links, loops, casts, and missing return types. Pure —
 * text in, facts out — so every rule stays testable. The rules reused here
 * are the repository's own checkers, so a mechanical grade says what
 * `deno task precommit` would say about the page.
 */

import { readComments } from "#scripts/check-comments/rules.ts";
import { countLines } from "#scripts/check-file-lengths/rules.ts";
import { topLevelImports } from "#scripts/check-imports/rules.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import {
  type ParsedStatement,
  parseProgram,
  visitNodes,
} from "#scripts/parse-program.ts";
import { blankSpans, stringSpanTexts } from "#scripts/typescript-lex.ts";

/** Which tree a page sits in, because the rules that apply differ. */
export type PageKind = "template" | "client" | "feature" | "shared" | "other";

/** One thing the page does, at a line the reader can jump to. */
export interface LineHit {
  line: number;
  text: string;
}

/** Everything the checks and the Jev questions look at. */
export interface PageFacts {
  asCasts: LineHit[];
  catchClauses: LineHit[];
  comments: { column: number; line: number; text: string }[];
  content: string;
  /** `??`, `||`, and `?.` in code, one hit each. */
  fallbacks: LineHit[];
  /** The page's path from the repository root. */
  file: string;
  forEachCalls: LineHit[];
  /** `href="..."` and `href={...}` sources, in order. */
  hrefs: string[];
  imports: string[];
  /** Computer-science words AGENTS.md asks plain language to replace. */
  jargonHits: { line: number; word: string }[];
  kind: PageKind;
  lines: number;
  missingReturnTypes: LineHit[];
  nonNullAssertions: LineHit[];
  /** SQL-looking statements, template parts included. */
  sql: string[];
  /** Batch and transaction calls, for the write-shape question. */
  writeCalls: LineHit[];
}

const KIND_BY_PREFIX: [prefix: string, kind: PageKind][] = [
  ["src/ui/templates", "template"],
  ["src/ui/client", "client"],
  ["src/features", "feature"],
  ["src/shared", "shared"],
];

export const pageKind = (file: string): PageKind =>
  KIND_BY_PREFIX.find(([prefix]) => file.startsWith(prefix))?.[1] ?? "other";

/** The trimmed source line around `index`, kept short enough to read. */
const lineTextAt = (content: string, index: number): string => {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  return content
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .slice(0, 90);
};

/** The hit one match makes: its line, with that line's source. */
const hitAtIndex = (content: string, index: number): LineHit => {
  const { line } = lineColumnAt(content, index);
  return { line, text: lineTextAt(content, index) };
};

/** Every regex match on `text`, as a line-addressed hit. */
const hitsFrom = (content: string, text: string, pattern: RegExp): LineHit[] =>
  [...text.matchAll(pattern)].map((match) => hitAtIndex(content, match.index));

/** One node's source text. The parser sets offsets on every node it hands
 * out, so this boundary read needs no second runtime check. */
const nodeText = (content: string, node: Record<string, unknown>): string =>
  content.slice(node.start as number, node.end as number);

/** Assertion and cast hits, walked from the page's syntax tree. `as const`
 * stays out: it states a literal's shape rather than claiming one. */
const assertionHits = (
  content: string,
  statements: ParsedStatement[],
): { assertions: LineHit[]; casts: LineHit[] } => {
  const assertions: LineHit[] = [];
  const casts: LineHit[] = [];
  visitNodes(statements, (node) => {
    if (node.type === "TSNonNullExpression") {
      assertions.push(hitAtIndex(content, node.start as number));
    }
    if (
      node.type === "TSAsExpression" &&
      !/\bas\s+const\b/.test(nodeText(content, node))
    ) {
      casts.push(hitAtIndex(content, node.start as number));
    }
  });
  return { assertions, casts };
};

/** A missing annotation, which the parser writes as null or undefined. */
const absent = (value: unknown): boolean =>
  value === undefined || value === null;

/** Where an export statement starts, as a line-addressed hit. */
const hitAt = (content: string, statement: ParsedStatement): LineHit =>
  hitAtIndex(content, statement.start);

/** One export statement, already narrowed by the caller's filter. */
type ExportStatement = ParsedStatement & { type: "ExportNamedDeclaration" };

/** The missing-return-type hits one export statement carries. */
const hitsFromStatement = (
  content: string,
  statement: ExportStatement,
): LineHit[] => {
  const declaration = statement.declaration;
  if (declaration === null) return [];
  if (declaration.type === "FunctionDeclaration") {
    return absent(declaration.returnType) && declaration.id !== null
      ? [hitAt(content, statement)]
      : [];
  }
  if (declaration.type !== "VariableDeclaration") return [];
  return declaration.declarations
    .filter((one) => {
      const init = one.init;
      if (init === null) return false;
      const isFunction =
        init.type === "ArrowFunctionExpression" ||
        init.type === "FunctionExpression";
      return (
        isFunction && absent(init.returnType) && absent(one.id.typeAnnotation)
      );
    })
    .map(() => hitAt(content, statement));
};

/** Exported functions whose return type the page never states. */
const missingReturnTypeHits = (
  content: string,
  statements: ParsedStatement[],
): LineHit[] =>
  statements
    .filter(
      (statement): statement is ExportStatement =>
        statement.type === "ExportNamedDeclaration",
    )
    .flatMap((statement) => hitsFromStatement(content, statement));

/** A statement's first words, as SQL writes them. Bare "delete" and
 * "update" are plain words inside route strings, so each keyword demands
 * the clause that follows it in a real statement. */
const SQL_STATEMENT_START =
  /^['"`]\s*(?:SELECT\s|INSERT\s+INTO\s|DELETE\s+FROM\s|UPDATE\s+\w+\s+SET\s|WITH\s+\w+\s+AS\s)/i;

/** Statements that read as SQL, from the string and template literals the
 * lexer already found. */
const sqlStatements = (content: string): string[] =>
  stringSpanTexts(content)
    .filter((text) => SQL_STATEMENT_START.test(text))
    .map((text) => text.slice(0, 400));

const JARGON_RE =
  /\b(predicate|predicates|cohort|cohorts|projection|projections|fold|folds|atom|atoms|monad|monads|functor|functors|memoize|memoizes|memoization|combinator|combinators)\b/gi;

/** Computer-science words the page leans on, for the language question. */
const jargonHits = (content: string): { line: number; word: string }[] =>
  [...content.matchAll(JARGON_RE)].map((match) => ({
    line: lineColumnAt(content, match.index).line,
    word: match[0].toLowerCase(),
  }));

/** Read one page into every fact the grader needs. */
export const extractPage = (file: string, content: string): PageFacts => {
  const codeOnly = blankSpans(content, true);
  const keepStrings = blankSpans(content, false);
  const statements = parseProgram(file, content).body;
  const { assertions, casts } = assertionHits(content, statements);
  return {
    asCasts: casts,
    catchClauses: hitsFrom(content, codeOnly, /\bcatch\s*\(|\.catch\s*\(/g),
    comments: readComments(content),
    content,
    fallbacks: hitsFrom(content, codeOnly, /\?\?|\|\||\?\./g),
    file,
    forEachCalls: hitsFrom(content, codeOnly, /\.forEach\s*\(/g),
    hrefs: [
      ...keepStrings.matchAll(
        /href=(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g,
      ),
    ]
      .map((match) => match[1] ?? match[2])
      .filter((href): href is string => href !== undefined),
    imports: topLevelImports(file, content).map((entry) => entry.specifier),
    jargonHits: jargonHits(content),
    kind: pageKind(file),
    lines: countLines(content),
    missingReturnTypes: missingReturnTypeHits(content, statements),
    nonNullAssertions: assertions,
    sql: sqlStatements(content),
    writeCalls: hitsFrom(
      content,
      codeOnly,
      /\b(?:executeBatch(?:WithResults)?|queryBatch(?:Primary)?|withTransaction)\s*\(|\.execute\s*\(/g,
    ),
  };
};

/** Whether a path under `src/` is a page module: the page sweep's rule. */
export const isPageModule = (file: string): boolean =>
  file.startsWith("src/") && /(?:^|\/)[a-z0-9.-]*pages?\.tsx?$/.test(file);
