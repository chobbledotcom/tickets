/**
 * Detectors for the numbered-parameter rules (#2198): a statement binds each
 * value once through the numbered binder, and SQL text never spells a `?N`
 * token itself. The live assertions sit in `../code-quality.test.ts`; the
 * crafted fixtures that prove both rules fire — and stay quiet — sit in
 * `./numbered-binds.test.ts`.
 */

import { blankSpans, lexicalSpans } from "#scripts/typescript-lex.ts";

/** The one file whose own job is to emit `?N` tokens. */
const NUMBERED_STATEMENT_PATH = "shared/db/numbered-statement.ts";

/** A digit directly after a `?`: a hand-written parameter number. */
const HAND_NUMBERED_TOKEN = /\?[0-9]/;

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

/** The bracket that closes the `[` at `open`, or -1. Brackets inside strings
 * and comments cannot mislead the walk: the text arrives pre-blanked. */
const matchingBracket = (blanked: string, open: number): number => {
  let depth = 0;
  for (let at = open; at < blanked.length; at++) {
    const character = blanked[at] as string;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
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

/** The repeated elements of one `args` array, as one violation per value that
 * appears more than once. */
const repeatedElementsOf = (
  content: string,
  blanked: string,
  open: number,
  close: number,
  line: number,
): string[] => {
  const counts = new Map<string, number>();
  for (const element of topLevelElements(content, blanked, open + 1, close)) {
    const text = element.trim();
    if (!PURE_BIND_ELEMENT.test(text)) continue;
    const value = text.replace(/^\.\.\.\s*/, "").trim();
    if (TYPE_WORDS.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const violations: string[] = [];
  for (const [value, count] of counts) {
    if (count > 1) {
      violations.push(
        `${line}: binds ${value} more than once; numberedStatement binds it once and reuses the token`,
      );
    }
  }
  return violations;
};

/** The repeated-bind violations of one source file. Within one `{ sql, args }`
 * statement, one comparable argument appearing twice means the statement
 * binds one value more than once; the numbered binder binds it once and
 * reuses the token. Allowed prefixes name the statements a wider assembly
 * carries — a clause built for the reader pipeline cannot convert alone. */
export const findRepeatedBinds = (
  relativePath: string,
  content: string,
  allowed: readonly string[],
): string[] => {
  if (allowed.some((prefix) => relativePath.startsWith(prefix))) return [];
  const blanked = blankSpans(content, true);
  const violations: string[] = [];
  for (const match of blanked.matchAll(/\bargs\s*:\s*\[/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;
    const line = lineAt(content, match.index ?? 0);
    violations.push(
      ...repeatedElementsOf(content, blanked, open, close, line).map(
        (violation) => `${relativePath}:${violation}`,
      ),
    );
  }
  return violations;
};

/** The hand-numbered `?N` tokens of one source file. The numbered binder is
 * the only writer of `?N` tokens, so SQL text never spells one itself; the
 * prose comments that kept such numbering honest are comments, which the
 * string-span walk never reads. */
export const findHandNumberedSql = (
  relativePath: string,
  content: string,
): string[] => {
  if (relativePath === NUMBERED_STATEMENT_PATH) return [];
  const violations: string[] = [];
  for (const span of lexicalSpans(content)) {
    if (span.kind !== "string") continue;
    const text = withoutInterpolations(content.slice(span.start, span.end));
    if (!HAND_NUMBERED_TOKEN.test(text)) continue;
    violations.push(
      `${relativePath}:${lineAt(content, span.start)}: SQL text carries a hand-numbered ?N token; build the statement through numberedStatement instead`,
    );
  }
  return violations;
};
