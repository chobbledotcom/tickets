/**
 * Detectors for the numbered-parameter rules (#2198): a statement binds each
 * value once through the numbered binder, and SQL text never spells a `?N`
 * token itself. The live assertions sit in `../code-quality.test.ts`; the
 * crafted fixtures that prove both rules fire — and stay quiet — sit in
 * `./numbered-binds.test.ts`.
 */

import { requiredMapValue } from "#fp";
import {
  blankSpans,
  interpolationEnd,
  lexicalSpans,
} from "#scripts/typescript-lex.ts";
import { matchingBracket } from "#test/scripts/code-quality/brackets.ts";
import {
  argumentUses,
  nameDeclarations,
  sqlCarryingStarts,
  sqlTextArgumentStarts,
} from "#test/scripts/code-quality/helper-binds.ts";
import {
  matchedBlocks,
  visibleDeclaration,
} from "#test/scripts/code-quality/scopes.ts";

/** The one file whose own job is to emit `?N` tokens. */
const NUMBERED_STATEMENT_PATH = "shared/db/numbered-statement.ts";

/** A digit directly after a `?`: a hand-written parameter number. */
const HAND_NUMBERED_TOKEN = /\?[0-9]/;

/** The name a token before a string span ends with: the constant an
 *  assignment to that name holds. */
const TOKEN_BEFORE = /([A-Za-z_$][\w$]*)$/;

/** The element shapes a repeated-bind check can compare: a variable or member
 * chain, a quoted literal, a number, or the same under one spread. A call may
 * answer two different values, so it never counts as a repeat. */
const PURE_BIND_ELEMENT =
  /^\s*(?:\.\.\.\s*)?(?:"[^"]*"|'[^']*'|[-0-9][0-9_.e]*n?|true|false|[$A-Za-z_][\w$]*(?:\?\.[\w$]+|\.[\w$]+)*)\s*$/;

/** Type annotations an `args:` position can carry; a type never binds. */
const TYPE_WORDS = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "readonly",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

/** One local array literal: its declaration's keyword and its literal's
 * brackets, all in the blanked text. */
type LocalArray = { close: number; open: number; start: number };

/** The lookup one spread name resolves: the one visible declaration it names,
 * or nothing when no declaration reaches the use. */
type LocalArrays = (name: string) => LocalArray[] | undefined;

/** The one-based line an index sits on. */
const lineAt = (content: string, index: number): number => {
  let line = 1;
  for (let at = 0; at < index; at++) {
    if (content[at] === "\n") line += 1;
  }
  return line;
};

/** The literal text of one string span: the interpolation code inside a
 * template is not SQL text, so it is blanked before the token check. */
const withoutInterpolations = (spanText: string): string => {
  let out = "";
  let depth = 0;
  for (let at = 1; at < spanText.length - 1; at++) {
    const character = spanText[at] as string;
    if (depth === 0 && character === "$" && spanText[at + 1] === "{") {
      depth = 1;
      at += 1;
      out += " ";
      continue;
    }
    if (depth > 0) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      out += " ";
      continue;
    }
    out += character;
  }
  return out;
};

/** The top-level element texts of one array literal, taken from the real
 * source at the bounds the blanked text marked. */
const topLevelElements = (
  content: string,
  blanked: string,
  start: number,
  end: number,
): string[] => {
  const elements: string[] = [];
  let depth = 0;
  let elementStart = start;
  for (let at = start; at < end; at++) {
    const character = blanked[at] as string;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      elements.push(content.slice(elementStart, at));
      elementStart = at + 1;
    }
  }
  elements.push(content.slice(elementStart, end));
  return elements;
};

/** The one message a value bound twice reports. */
const repeatedBindMessage = (line: number, value: string): string =>
  `${line}: binds ${value} more than once; numberedStatement binds it once and reuses the token`;

/** The elements one spread of a local array contributes: the array's own
 * elements, one level deep, or null when no local array answers. */
const spreadElements = (
  content: string,
  blanked: string,
  value: string,
  expand: LocalArrays,
): string[] | null => {
  const elements: string[] = [];
  for (const { open, close } of expand(value) ?? []) {
    for (const inner of topLevelElements(content, blanked, open + 1, close)) {
      elements.push(inner);
    }
  }
  return elements.length > 0 ? elements : null;
};

/** The repeated elements of one `args` array, as one violation per value that
 * appears more than once. A spread of a local array carries that array's
 * values into the statement, so its elements count in the spread's place, one
 * level deep. */
const repeatedElementsOf = (
  content: string,
  blanked: string,
  open: number,
  close: number,
  line: number,
  expand?: LocalArrays,
): string[] => {
  const counts = new Map<string, number>();
  const countValue = (value: string): void => {
    if (TYPE_WORDS.has(value)) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  const countElement = (element: string, depth: number): void => {
    const text = element.trim();
    if (!PURE_BIND_ELEMENT.test(text)) return;
    const value = text.replace(/^\.\.\.\s*/, "").trim();
    if (text.startsWith("...") && depth === 0 && expand) {
      countSpread(expand, value, depth);
    } else {
      countValue(value);
    }
  };
  const countSpread = (
    expand: LocalArrays,
    value: string,
    depth: number,
  ): void => {
    const inner = spreadElements(content, blanked, value, expand);
    if (inner === null) {
      countValue(value);
      return;
    }
    for (const element of inner) countElement(element, depth + 1);
  };
  for (const element of topLevelElements(content, blanked, open + 1, close)) {
    countElement(element, 0);
  }
  const violations: string[] = [];
  for (const [value, count] of counts) {
    if (count > 1) violations.push(repeatedBindMessage(line, value));
  }
  return violations;
};

/** The local array literals of one file, by name: the values a statement can
 * receive through one of the argument uses below. The declaration's type
 * annotation, when it carries one, sits between the name and the `=`; it
 * never holds `=`, `;`, `{`, or `}`, so the match cannot cross into another
 * statement. Production writes bind lists this way (a `const args: number[]`
 * member-quantity list), so an annotated list hides a repeat as well as a
 * bare one. */
const LOCAL_ARRAY_LITERAL =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*?)?=\s*\[/g;

const localArrayLiterals = (blanked: string): Map<string, LocalArray[]> => {
  const literals = new Map<string, LocalArray[]>();
  for (const match of [...blanked.matchAll(LOCAL_ARRAY_LITERAL)]) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;
    const name = match[1] as string;
    const spans = literals.get(name) ?? [];
    spans.push({ close, open, start: match.index });
    literals.set(name, spans);
  }
  return literals;
};

/** One args array a statement binds: where the array sits, the line it is
 * written on, and the position of the use that reached it. */
type FoundBinds = { at: number; close: number; line: number; open: number };

/** The repeated-bind violations of one source file. Within one `{ sql, args }`
 * statement, one comparable argument appearing twice means the statement
 * binds one value more than once; the numbered binder binds it once and
 * reuses the token. */
export const findRepeatedBinds = (
  relativePath: string,
  content: string,
): string[] => {
  const blanked = blankSpans(content, true);
  const locals = localArrayLiterals(blanked);
  const blocks = matchedBlocks(blanked);
  const resolve = (name: string, at: number): LocalArray[] | undefined => {
    const visible = visibleDeclaration(blocks, locals.get(name), at);
    return visible === undefined ? undefined : [visible];
  };
  const violations: string[] = [];
  const report = (found: FoundBinds): void => {
    violations.push(
      ...repeatedElementsOf(
        content,
        blanked,
        found.open,
        found.close,
        found.line,
        (name) => resolve(name, found.at),
      ).map((violation) => `${relativePath}:${violation}`),
    );
  };
  for (const match of [...blanked.matchAll(/\bargs\s*:\s*\[/g)]) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;
    report({
      at: match.index,
      close,
      line: lineAt(content, match.index),
      open,
    });
  }
  for (const use of argumentUses(blanked)) {
    if (use.kind === "array") {
      report({
        at: use.at,
        close: use.array.close,
        line: lineAt(content, use.array.open),
        open: use.array.open,
      });
      continue;
    }
    for (const { open, close } of resolve(use.name, use.at) ?? []) {
      report({ at: use.at, close, line: lineAt(content, open), open });
    }
  }
  return violations;
};

/** The string spans one template's interpolations hold, in absolute
 * positions: a quoted fragment or a nested template an interpolation
 * carries, however deeply the templates nest. The interpolation's code is
 * never SQL text itself, so only its string spans count. */
const interpolationStringSpans = (
  content: string,
  start: number,
  end: number,
): { end: number; start: number }[] => {
  const spans: { end: number; start: number }[] = [];
  let at = start;
  while (at < end) {
    if (content[at] === "$" && content[at + 1] === "{") {
      const close = interpolationEnd(content, at + 2);
      const region = content.slice(at + 2, close);
      for (const span of lexicalSpans(region)) {
        if (span.kind !== "string") continue;
        spans.push({ end: at + 2 + span.end, start: at + 2 + span.start });
      }
      at = close + 1;
      continue;
    }
    at += 1;
  }
  return spans;
};

/** Whether the code before `at` ends in an `sql:` property: the string at
 * `at` is a statement's SQL text, as the `{ sql, args }` object form writes
 * it. The walk reads the blanked text, where only real code shows, and stops
 * on the colon the property ends with. */
const followsSqlProperty = (blanked: string, at: number): boolean => {
  let cursor = at;
  while (cursor > 0 && /\s/.test(blanked[cursor - 1] as string)) cursor -= 1;
  if (blanked[cursor - 1] !== ":") return false;
  if (cursor < 4) return false;
  const word = blanked.slice(cursor - 4, cursor - 1);
  if (word !== "sql") return false;
  return !/[A-Za-z0-9_$]/.test(blanked[cursor - 5] ?? "");
};

/** The hand-numbered `?N` tokens of one source file. The numbered binder is
 * the only writer of `?N` tokens, so SQL text never spells one itself; the
 * prose comments that kept such numbering honest are comments, which the
 * string-span walk never reads. The walk judges SQL text only: a template
 * literal, an `sql:` property's string, the statement string a SQL helper
 * call carries, or a quoted string an assignment holds for the `sql` name
 * or for a constant whose visible declaration a SQL helper call receives.
 * The constant is the binding the scope resolution reaches: a same-named
 * constant in an unrelated or shadowing scope is prose the rule does not
 * judge. Every other string is prose, and the walk skips it. A template's
 * SQL text is checked with its interpolations blanked, and each
 * interpolation's own string spans — the conditional fragments an assembly
 * writes — are checked in their place. */
export const findHandNumberedSql = (
  relativePath: string,
  content: string,
): string[] => {
  if (relativePath === NUMBERED_STATEMENT_PATH) return [];
  const blanked = blankSpans(content, true);
  const statementStringStarts = sqlTextArgumentStarts(content, blanked);
  const blocks = matchedBlocks(blanked);
  const declarations = nameDeclarations(blanked);
  const carrying = sqlCarryingStarts(blanked, blocks, declarations);
  const sqlCarries = (name: string, at: number): boolean => {
    const visible = visibleDeclaration(blocks, declarations.get(name), at);
    return visible !== undefined && carrying.has(visible.start);
  };
  const violations: string[] = [];
  const check = (start: number, end: number): void => {
    const text = content.slice(start, end);
    if (HAND_NUMBERED_TOKEN.test(withoutInterpolations(text))) {
      violations.push(
        `${relativePath}:${lineAt(content, start)}: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead`,
      );
    }
    if (content[start] !== "`") return;
    for (const span of interpolationStringSpans(content, start, end)) {
      check(span.start, span.end);
    }
  };
  const sqlAssigned = (at: number): boolean => {
    let cursor = at;
    while (cursor > 0 && /\s/.test(blanked[cursor - 1] as string)) cursor -= 1;
    const before = cursor - 1;
    if (before < 0) return false;
    if (blanked[before] !== "=" || blanked[before - 1] === "=") return false;
    const token = blanked.slice(0, before).trimEnd();
    if (/\bsql$/.test(token)) return true;
    const name = token.match(TOKEN_BEFORE);
    return name !== null && sqlCarries(name[1] as string, at);
  };
  const isSqlText = (at: number): boolean =>
    content[at] === "`" ||
    statementStringStarts.has(at) ||
    followsSqlProperty(blanked, at) ||
    sqlAssigned(at);
  for (const span of lexicalSpans(content)) {
    if (span.kind === "string" && isSqlText(span.start)) {
      check(span.start, span.end);
    }
  }
  return violations;
};

/** The violations the two numbered-parameter rules report over one loaded
 * source tree: each detector over every file. `toRelative` names each file
 * the way a finding reports it. */
export const findNumberedBindViolations = (
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
  toRelative: (file: string) => string,
): string[] => [
  ...files.flatMap((file) =>
    findRepeatedBinds(
      toRelative(file),
      requiredMapValue(contents, file, `Missing source text for ${file}`),
    ),
  ),
  ...files.flatMap((file) =>
    findHandNumberedSql(
      toRelative(file),
      requiredMapValue(contents, file, `Missing source text for ${file}`),
    ),
  ),
];
