/**
 * Turn one source file into the facts the grader checks: comments, fallback
 * operators, SQL, links, loops, casts, and missing return types. Pure —
 * text in, facts out — so every rule stays testable. The rules reused here
 * are the repository's own checkers, so a mechanical grade says what
 * `deno task precommit` would say about the file.
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

/** Which tree a file sits in, because the rules that apply differ. */
export type CodeKind = "template" | "client" | "feature" | "shared" | "other";

/** One thing the file does, at a line the reader can jump to. */
export interface LineHit {
  line: number;
  text: string;
}

/** Everything the checks and the Jev questions look at. */
export interface CodeFacts {
  asCasts: LineHit[];
  catchClauses: LineHit[];
  comments: { column: number; line: number; text: string }[];
  content: string;
  /** `??`, `||`, and `?.` in code, one hit each. */
  fallbacks: LineHit[];
  /** The file's path from the repository root. */
  file: string;
  forEachCalls: LineHit[];
  /** `href="..."` and `href={...}` sources, in order. */
  hrefs: string[];
  imports: string[];
  /** Computer-science words AGENTS.md asks plain language to replace. */
  jargonHits: { line: number; word: string }[];
  kind: CodeKind;
  lines: number;
  missingReturnTypes: LineHit[];
  nonNullAssertions: LineHit[];
  /** Whether the file renders JSX, so the copy and naming questions apply. */
  rendersJsx: boolean;
  /** SQL-looking statements, template parts included. */
  sql: string[];
  /** Calls that can write, for the write-shape question. */
  writeCalls: LineHit[];
}

const KIND_BY_PREFIX: [prefix: string, kind: CodeKind][] = [
  ["src/ui/templates", "template"],
  ["src/ui/client", "client"],
  ["src/features", "feature"],
  ["src/shared", "shared"],
];

export const codeKind = (file: string): CodeKind =>
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

/** Assertion and cast hits, walked from the file's syntax tree. `as const`
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

/** A function the file declares at the top level, and where it starts. The
 * name is null for an anonymous `export default function`. */
interface DeclaredFunction {
  name: string | null;
  start: number;
  typed: boolean;
}

/** The functions one declaration names: a function, or variables holding
 * arrow or function expressions. */
const functionsDeclaredBy = (node: ParsedStatement): DeclaredFunction[] => {
  if (node.type === "FunctionDeclaration") {
    return [
      {
        name: node.id === null ? null : node.id.name,
        start: node.start,
        typed: !absent(node.returnType),
      },
    ];
  }
  if (node.type !== "VariableDeclaration") return [];
  return node.declarations.flatMap((one) => {
    const init = one.init;
    if (
      one.id.type !== "Identifier" ||
      init === null ||
      (init.type !== "ArrowFunctionExpression" &&
        init.type !== "FunctionExpression")
    ) {
      return [];
    }
    return [
      {
        name: one.id.name,
        start: node.start,
        typed: !absent(init.returnType) || !absent(one.id.typeAnnotation),
      },
    ];
  });
};

/** Where each untyped function an export statement makes public starts:
 * declared in place, exported by name from a list, or exported as the
 * default. A re-export from another module is that module's to check. */
const untypedExportStarts = (
  content: string,
  statement: ParsedStatement,
  local: Map<string | null, DeclaredFunction>,
): number[] => {
  const untypedLocal = (name: string): number[] => {
    const found = local.get(name);
    return found === undefined || found.typed ? [] : [found.start];
  };
  const untypedDeclared = (declaration: ParsedStatement): number[] =>
    functionsDeclaredBy(declaration)
      .filter((declared) => !declared.typed)
      .map(() => statement.start);
  if (statement.type === "ExportNamedDeclaration") {
    if (statement.declaration !== null) {
      return untypedDeclared(statement.declaration);
    }
    if (statement.source !== null) return [];
    // Without a source module, every exported name is a local identifier.
    return statement.specifiers.flatMap(({ local: name }) =>
      untypedLocal(content.slice(name.start, name.end)),
    );
  }
  if (statement.type !== "ExportDefaultDeclaration") return [];
  const declaration = statement.declaration;
  if (declaration.type === "Identifier") return untypedLocal(declaration.name);
  if (declaration.type === "FunctionDeclaration") {
    return untypedDeclared(declaration);
  }
  const isFunction =
    declaration.type === "ArrowFunctionExpression" ||
    declaration.type === "FunctionExpression";
  return isFunction && absent(declaration.returnType) ? [statement.start] : [];
};

/** Exported functions whose return type the file never states. */
const missingReturnTypeHits = (
  content: string,
  statements: ParsedStatement[],
): LineHit[] => {
  const local = new Map(
    statements
      .flatMap(functionsDeclaredBy)
      .map((declared) => [declared.name, declared]),
  );
  return statements
    .flatMap((statement) => untypedExportStarts(content, statement, local))
    .sort((left, right) => left - right)
    .map((start) => hitAtIndex(content, start));
};

/** A bare call to a helper that writes an activity row. */
const ACTIVITY_WRITE_CALL = String.raw`(?<!\.)\b(?:logActivity|logActivities|logAttributeOptionActivity|logAndNotifyRegistration|logRefundLedgerError)\s*\(`;

/** Calls that are named like a write but are not database operations. */
const NON_WRITE_HELPERS: Record<string, true> = {
  setImmediate: true,
  setInterval: true,
  setTimeout: true,
};

/** A call that can write: a raw batch, transaction, or execute; a table's
 * insert, update, or delete; or a bare helper named for a write, such as
 * setAnswerModifier or logActivity. Files mostly write through the last
 * two, so the transaction question must see them. Member calls such as
 * document.createElement and state setters are not writes, and a bare
 * logging helper such as logError is not one either. */
const WRITE_CALL = new RegExp(
  [
    String.raw`\b(?:executeBatch(?:WithResults)?|queryBatch(?:Primary)?|withTransaction)\s*\(`,
    String.raw`\.(?:execute|insert|update|upsert|deleteById|delete)\s*\(`,
    String.raw`(?<!\.)\b(?:set|save|create|delete|update|insert|upsert|remove|record)[A-Z]\w*\s*\(`,
    ACTIVITY_WRITE_CALL,
  ].join("|"),
  "g",
);

const writeCallsFrom = (content: string): LineHit[] => {
  const codeOnly = blankSpans(content, true);
  const hits: LineHit[] = [];
  for (const match of codeOnly.matchAll(WRITE_CALL)) {
    const callee = match[0]
      .replace(/\s*\(\s*$/, "")
      .split(".")
      .pop()!;
    if (NON_WRITE_HELPERS[callee] === true) continue;
    hits.push(hitAtIndex(content, match.index));
  }
  return hits;
};

/** A statement's first words, as SQL writes them. Bare "delete" and
 * "update" are plain words inside route strings, so each keyword demands
 * the clause that follows it in a real statement. */
const SQL_STATEMENT_START =
  /^['"`]\s*(?:SELECT\s|INSERT\s+INTO\s|DELETE\s+FROM\s|UPDATE\s+\w+\s+SET\s|WITH\s+\w+\s*(?:\([^)]*\))?\s+AS\s)/i;

/** Statements that read as SQL, from the string and template literals the
 * lexer already found. */
const sqlStatements = (content: string): string[] =>
  stringSpanTexts(content)
    .filter((text) => SQL_STATEMENT_START.test(text))
    .map((text) => text.slice(0, 400));

const JARGON_RE =
  /\b(predicate|predicates|cohort|cohorts|projection|projections|fold|folds|atom|atoms|monad|monads|functor|functors|memoize|memoizes|memoization|combinator|combinators)\b/gi;

/** Computer-science words the file leans on, for the language question. */
const jargonHits = (content: string): { line: number; word: string }[] =>
  [...content.matchAll(JARGON_RE)].map((match) => ({
    line: lineColumnAt(content, match.index).line,
    word: match[0].toLowerCase(),
  }));

/** The text of one JSX attribute if it is an href, or null. The parser
 * guarantees the node shapes below, so the boundary read needs no runtime
 * checks. */
const hrefTextOf = (
  content: string,
  node: Record<string, unknown>,
): string | null => {
  if (node.type !== "JSXAttribute") return null;
  const name = node.name as { name?: unknown };
  if (name.name !== "href") return null;
  const value = node.value as {
    type?: unknown;
    value?: unknown;
    expression: { start: number; end: number };
  };
  if (value.type === "Literal") return value.value as string;
  return content.slice(value.expression.start, value.expression.end);
};

/** The href sources in JSX: the string of a literal, or the full text of an
 * expression, nested braces included. */
const jsxHrefs = (content: string, statements: ParsedStatement[]): string[] => {
  const hrefs: string[] = [];
  visitNodes(statements, (node) => {
    const href = hrefTextOf(content, node);
    if (href !== null) hrefs.push(href);
  });
  return hrefs;
};

/** Whether the parsed program renders JSX, so the copy questions apply. */
const hasJsx = (statements: ParsedStatement[]): boolean => {
  let found = false;
  visitNodes(statements, (node) => {
    if (node.type === "JSXElement" || node.type === "JSXFragment") found = true;
  });
  return found;
};

/** Read one file into every fact the grader needs. */
export const extractCode = (file: string, content: string): CodeFacts => {
  const codeOnly = blankSpans(content, true);
  const statements = parseProgram(file, content).body;
  const { assertions, casts } = assertionHits(content, statements);
  return {
    asCasts: casts,
    catchClauses: hitsFrom(
      content,
      codeOnly,
      /\bcatch\s*\(|\.catch\s*\(|\bcatch\s*\{/g,
    ),
    comments: readComments(content),
    content,
    fallbacks: hitsFrom(content, codeOnly, /\?\?|\|\||\?\./g),
    file,
    forEachCalls: hitsFrom(content, codeOnly, /\.forEach\s*\(/g),
    hrefs: jsxHrefs(content, statements),
    imports: topLevelImports(file, content).map((entry) => entry.specifier),
    jargonHits: jargonHits(content),
    kind: codeKind(file),
    lines: countLines(content),
    missingReturnTypes: missingReturnTypeHits(content, statements),
    nonNullAssertions: assertions,
    rendersJsx: hasJsx(statements),
    sql: sqlStatements(content),
    writeCalls: writeCallsFrom(content),
  };
};
