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

/** The one message a value bound twice reports. */
const repeatedBindMessage = (line: number, value: string): string =>
  `${line}: binds ${value} more than once; numberedStatement binds it once and reuses the token`;

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
  expand?: (name: string) => Array<{ open: number; close: number }>,
): string[] => {
  const counts = new Map<string, number>();
  const countElement = (element: string, depth: number): void => {
    const text = element.trim();
    if (!PURE_BIND_ELEMENT.test(text)) return;
    const value = text.replace(/^\.\.\.\s*/, "").trim();
    if (TYPE_WORDS.has(value)) return;
    if (text.startsWith("...") && depth === 0) {
      const literals = expand?.(value) ?? [];
      if (literals.length > 0) {
        for (const { open, close } of literals) {
          for (const inner of topLevelElements(content, blanked, open + 1, close)) {
            countElement(inner, depth + 1);
          }
        }
        return;
      }
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
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

/** The text span of one top-level declaration: from its keyword to the close
 * of its first brace group, or to the end of the text when the declaration
 * carries no braces. `[-1, -1]` when the file declares no such name. */
const declarationSpan = (blanked: string, name: string): [number, number] => {
  const declared = blanked.match(
    new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`),
  );
  if (declared?.index === undefined) return [-1, -1];
  const open = blanked.indexOf("{", declared.index);
  if (open < 0) return [declared.index, blanked.length];
  const close = matchingBracket(blanked, open);
  return close < 0
    ? [declared.index, blanked.length]
    : [declared.index, close + 1];
};

/** The local array literals of one file, by name: the values a statement can
 * receive through one of the argument uses below. */
const localArrayLiterals = (
  blanked: string,
): Map<string, Array<{ open: number; close: number }>> => {
  const literals = new Map<string, Array<{ open: number; close: number }>>();
  for (const match of blanked.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g,
  )) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;
    const name = match[1] as string;
    const spans = literals.get(name) ?? [];
    spans.push({ open, close });
    literals.set(name, spans);
  }
  return literals;
};

/** The bare name of a call's second argument, or null when the call passes
 * nothing comparable there: one argument only, or a member chain, or a
 * literal. */
const secondCallArgument = (blanked: string, open: number): string | null => {
  let depth = 0;
  let at = open + 1;
  for (; at < blanked.length; at++) {
    const character = blanked[at] as string;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) {
      if (depth === 0) return null;
      depth -= 1;
    }
    if (character === "," && depth === 0) break;
  }
  if (at >= blanked.length) return null;
  const named = blanked.slice(at + 1).match(/^\s*([A-Za-z_$][\w$]*)\s*[,)\]]/);
  return named ? (named[1] as string) : null;
};

/** The positions where a bare name reaches a statement as its bind list: an
 * `args: name` property, the `args` shorthand in an object literal, and the
 * second argument of an `execute` call. */
const argumentUses = (blanked: string): Array<{ name: string; at: number }> => {
  const uses: Array<{ name: string; at: number }> = [];
  for (const match of blanked.matchAll(
    /\bargs\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g,
  )) {
    uses.push({ name: match[1] as string, at: match.index ?? 0 });
  }
  for (const match of blanked.matchAll(/\{[^{}]*\bargs\s*(?=[,}])/g)) {
    uses.push({ name: "args", at: match.index ?? 0 });
  }
  for (const match of blanked.matchAll(/\bexecute\s*\(/g)) {
    const name = secondCallArgument(
      blanked,
      (match.index ?? 0) + match[0].length - 1,
    );
    if (name !== null) uses.push({ name, at: match.index ?? 0 });
  }
  return uses;
};

/** The repeated-bind violations of one source file. Within one `{ sql, args }`
 * statement, one comparable argument appearing twice means the statement
 * binds one value more than once; the numbered binder binds it once and
 * reuses the token. An allowed entry names a whole file, or `file:declaration`
 * for one top-level declaration — the clause assemblies whose parts cannot
 * convert alone. */
export const findRepeatedBinds = (
  relativePath: string,
  content: string,
  allowed: readonly string[],
): string[] => {
  const blanked = blankSpans(content, true);
  const exempt = (at: number): boolean =>
    allowed.some((entry) => {
      const separator = entry.lastIndexOf(":");
      if (separator < 0) return relativePath.startsWith(entry);
      if (!relativePath.startsWith(entry.slice(0, separator))) return false;
      const [start, end] = declarationSpan(blanked, entry.slice(separator + 1));
      return start >= 0 && at >= start && at < end;
    });
  const locals = localArrayLiterals(blanked);
  const expand = (name: string) => locals.get(name);
  const violations: string[] = [];
  const report = (
    open: number,
    close: number,
    line: number,
    at: number,
  ): void => {
    if (exempt(at)) return;
    violations.push(
      ...repeatedElementsOf(content, blanked, open, close, line, expand).map(
        (violation) => `${relativePath}:${violation}`,
      ),
    );
  };
  for (const match of blanked.matchAll(/\bargs\s*:\s*\[/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;
    report(open, close, lineAt(content, match.index ?? 0), match.index ?? 0);
  }
  for (const use of argumentUses(blanked)) {
    for (const { open, close } of locals.get(use.name) ?? []) {
      report(open, close, lineAt(content, open), use.at);
    }
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
