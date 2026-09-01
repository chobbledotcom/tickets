/**
 * Whether a `/` divides or opens a pattern: the one question every scanner of
 * a function body has to answer without parsing, answered from the tokens
 * before it the way JavaScript itself answers it.
 */

import {
  endOfBraceGroup,
  endOfRun,
  endOfRunAt,
  opensComment,
  type RunReader,
  templateEndingAt,
} from "#scripts/quoted-run.ts";
import { SYNTAX_WORDS } from "#scripts/syntax-words.ts";

/** Whether a character can begin a word. The `#` is for private names. */
export const isWordStart = (character: string): boolean =>
  /[A-Za-z_$#]/.test(character);

export const isWordPart = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);

/** Whether a character doubles into a step operator, `++` or `--`. Written out
 * one of those ends a value, so a slash after it divides. */
export const isStepChange = (character: string): boolean =>
  character === "+" || character === "-";

/** The place the word that holds `from` starts, reading backward. */
const wordStart = (text: string, from: number): number => {
  let start = from;
  while (start > 0 && isWordPart(text[start - 1] as string)) start--;
  return start;
};

/** The word that stands just before `at`, past any whitespace between, or
 * nothing when no word stands there. */
const wordBefore = (text: string, at: number): string | undefined => {
  let end = at - 1;
  while (end >= 0 && /\s/.test(text[end] as string)) end--;
  if (end < 0 || !isWordPart(text[end] as string)) return;
  return text.slice(wordStart(text, end), end + 1);
};

/**
 * The position where the bracket that closes at `end` finds its match,
 * reading backward through `reads`, or -1 when nothing matches it.
 */
const walkToMatch = (
  reads: (at: number) => string | undefined,
  end: number,
  closes: string,
  opens: string,
): number => {
  let depth = 0;
  for (let at = end; at >= 0; at--) {
    const item = reads(at);
    if (item === closes) depth++;
    if (item !== opens) continue;
    depth--;
    if (depth === 0) return at;
  }
  return -1;
};

/**
 * The position of the `(` that the `)` at `index` closes, or -1 when nothing
 * matches it: the boundary scan over raw text asks the same header question
 * the token scan asks over shapes.
 */
const parenBefore = (text: string, index: number): number =>
  walkToMatch((at) => text[at], index, ")", "(");

/** Whether the `)` at `index` closed a control header, with `for await`
 * counted as one: `await` sits beside the bracket there, but `await (…)`
 * alone is an operand, so the word before the word decides. */
const closesAHeaderIn = (text: string, index: number): boolean => {
  const paren = parenBefore(text, index);
  if (paren === -1) return false;
  const word = wordBefore(text, paren);
  if (word === "await") {
    return wordBefore(text, paren - "await".length - 1) === "for";
  }
  return HEADER_WORDS.has(word ?? "");
};

/** The whole word the character at `index` sits inside. */
const wordAt = (text: string, index: number): string => {
  let end = index;
  while (end < text.length && isWordPart(text[end] as string)) end++;
  return text.slice(wordStart(text, index), end);
};

/**
 * What the token before a slash counts as, when the boundary scan has to tell
 * a divide from a pattern. Whitespace keeps whatever came before it, and
 * anything that ends no value clears it, so an operator puts a pattern back in
 * reach. A word reads as the word itself when the syntax list holds it — so
 * `return` ends no value, the way it does in the token scan — and as `ID`
 * otherwise: a `${…}` never opens with a keyword a pattern could follow. A
 * `)` that closed a control header ends no value either — a pattern can
 * follow `if (ready)` inside an interpolation the same as outside one.
 */
const valueEndingAt = (
  text: string,
  index: number,
  before: string | undefined,
): string | undefined => {
  const character = text[index] as string;
  if (/\s/.test(character)) return before;
  if (isWordPart(character)) {
    const word = wordAt(text, index);
    return SYNTAX_WORDS.has(word) ? word : "ID";
  }
  if (character === ")") {
    if (closesAHeaderIn(text, index)) return;
    return ")";
  }
  if (isStepChange(character) && text[index - 1] === character) {
    return character + character;
  }
  return ")]}".includes(character) ? character : undefined;
};

/**
 * Just past the `/` closing a regular expression, and its flags. A `/` inside
 * a character class does not close one, so `/a[/]b/` is read whole.
 */
export const endOfRegExp = (text: string, start: number): number => {
  let inClass = false;
  let index = endOfRun(text, start, (at) => {
    if (text[at] === "/" && !inClass) return null;
    if (text[at] === "[") inClass = true;
    if (text[at] === "]") inClass = false;
    return at + 1;
  });
  while (index < text.length && /[a-z]/.test(text[index] as string)) index++;
  return index;
};

/** Where a run that can hold a brace of its own opens at `index` — a quote, a
 * template, a comment or a pattern — and where it ends. Skipping these whole
 * keeps the braces inside them from being counted. */
const endOfNested = (
  text: string,
  index: number,
  before?: string,
): number | null => {
  const run = endOfRunAt(text, index, endOfTemplate);
  if (run !== null) return run;
  if (text[index] !== "/") return null;
  return ENDS_A_VALUE.has(before ?? "") ? null : endOfRegExp(text, index + 1);
};

/** Just past the `}` closing the `${` that opened at `start`, read with the
 * slash context a pattern after a header or an operator needs. */
export const endOfInterpolation: RunReader = (text, start) =>
  endOfBraceGroup(text, start, (index, before) => {
    const nested = endOfNested(text, index, before);
    if (nested !== null) {
      return { before: opensComment(text, index) ? before : "RE", end: nested };
    }
    return { before: valueEndingAt(text, index, before), end: null };
  });

/** Just past the backtick closing the template that opened before `start`,
 * crossing each interpolation with the decisions above. */
export const endOfTemplate: RunReader = templateEndingAt(endOfInterpolation);

/**
 * Tokens a value can end on. A `/` after one of these divides; a `/` anywhere
 * else opens a regular expression. This is the whole of what tells the two
 * apart without parsing, and it is what JavaScript itself relies on.
 */
const ENDS_A_VALUE = new Set([
  ")",
  "++",
  "--",
  "]",
  "}",
  "ID",
  "NUM",
  "RE",
  "STR",
  "false",
  "null",
  "this",
  "true",
  "undefined",
]);

/** The words whose header sits in brackets. The `)` that closes one of these
 * ends no value, because what follows is a statement, not more of a sum. */
const HEADER_WORDS = new Set(["for", "if", "while"]);

/** The tokens a `{` sits after when it opens a block rather than a value: the
 * header of a control statement, another statement's end, an arrow's body, or
 * the head of the body itself. A `{` after a name opens the body of what the
 * name declares — `class Helper {`, `enum Kind {` — because a value's `{`
 * always follows an operator, a bracket, or a keyword like `return`, never a
 * bare name. */
const BLOCK_BRACE_AFTER = new Set([
  "",
  ")",
  ";",
  "{",
  "}",
  "=>",
  "ID",
  "catch",
  "do",
  "else",
  "finally",
  "try",
]);

/** Walks back through `shape` to the position of the bracket that matches the
 * one at the end, or -1 when nothing matches it. */
const matchingOpener =
  (closes: string, opens: string) =>
  (shape: readonly string[]): number =>
    walkToMatch((at) => shape[at], shape.length - 1, closes, opens);

const parenOpensAt = matchingOpener(")", "(");
const bracketOpensAt = matchingOpener("]", "[");
const braceOpensAt = matchingOpener("}", "{");

/**
 * Whether the `)` at the end of `shape` closed a control header, `for await`
 * counted as one: `if (ready)` and `for (const a of b)` close on a statement,
 * while `total()` closes on a value, and `await (…)` alone is an operand —
 * the word before the word decides.
 */
const closesAHeader = (shape: readonly string[]): boolean => {
  const at = parenOpensAt(shape);
  if (at === -1) return false;
  const word = shape[at - 1] ?? "";
  if (word !== "await") return HEADER_WORDS.has(word);
  return shape[at - 2] === "for";
};

/** The tokens a label or a case clause is made of: the name it labels by, a
 * dotted match value, and the two clause keywords. A bracketed stretch counts
 * too, so the walk crosses it and keeps going. */
const LABEL_PARTS = new Set([".", "ID", "NUM", "STR", "case", "default"]);

/** The position before the bracketed stretch that ends `shape`, or -1 when
 * nothing matches its closer, so a walk over labels can cross a balanced
 * stretch whole and keep going. */
const beforeBracketed = (
  openerAt: (shape: readonly string[]) => number,
  shape: readonly string[],
  from: number,
): number => {
  const open = openerAt(shape.slice(0, from + 1));
  return open === -1 ? -1 : open - 1;
};

/** One step back over a label's words: a name or a dotted match value steps
 * back a token, a balanced bracket — a call, a parenthesised arm, an index —
 * crosses whole, and anything else stops the walk where it stands. */
const stepBackOverLabel = (shape: readonly string[], index: number): number => {
  const token = shape[index] as string;
  if (token === ")") return beforeBracketed(parenOpensAt, shape, index);
  if (token === "]") return beforeBracketed(bracketOpensAt, shape, index);
  return LABEL_PARTS.has(token) ? index - 1 : index;
};

/**
 * Whether the `{` at `at`, which follows a colon, opens a labeled block or a
 * case clause rather than a property. The label walks back — balanced
 * brackets crossed whole — to whatever stands before it: a question mark, a
 * comma, or an assignment says an expression — a ternary's arm, an object's
 * next property, a call's next argument; an enclosing object says a property;
 * a value just closed says the same; and anything else says a statement
 * boundary, which is a label's. The clause keywords say a case whatever went
 * before.
 */
const labeledBrace = (shape: readonly string[], at: number): boolean => {
  let index = at - 2;
  let clause = false;
  while (index >= 0) {
    const stepped = stepBackOverLabel(shape, index);
    if (stepped === index) break;
    clause = clause || shape[index] === "case" || shape[index] === "default";
    index = stepped;
  }
  if (clause) return true;
  const before = shape[index] ?? "";
  if (before === "?" || before === ",") return false;
  if (before === "{") return braceOpensABlock(shape, index);
  if (before === "}") return !braceEndedAValue(shape.slice(0, index + 1));
  return true;
};

/** Whether the brace that opens at `at` holds statements rather than a value. */
const braceOpensABlock = (shape: readonly string[], at: number): boolean => {
  const before = shape[at - 1] ?? "";
  if (before === ":") return labeledBrace(shape, at);
  return BLOCK_BRACE_AFTER.has(before);
};

/**
 * Whether the `}` at the end of `shape` closed a value an operator can work
 * on, rather than a block a statement follows: an assignment, a bracket, a
 * block opener, or a value-making keyword means a value, and a label or a case
 * clause means statements. A `}` that closes nothing takes the reading the
 * unmatched `)` does, and divides.
 */
const braceEndedAValue = (shape: readonly string[]): boolean => {
  const at = braceOpensAt(shape);
  return at === -1 ? true : !braceOpensABlock(shape, at);
};

/**
 * Whether the `/` at `index` divides, rather than opening a pattern: the
 * reader an import scanner borrows, so a pattern's own brackets cannot pose
 * as comment openers inside it.
 */
export const slashDivides = (text: string, index: number): boolean => {
  let at = index - 1;
  while (at >= 0 && /\s/.test(text[at] as string)) at--;
  if (at < 0) return false;
  return ENDS_A_VALUE.has(valueEndingAt(text, at, undefined) ?? "");
};

/**
 * Whether the token before a slash ends a value, so the slash divides it. A
 * `)` is the one token that depends on what came before it: `total() / 2`
 * divides, but `if (ready) /foo/.test(value)` opens a pattern. A `}` is the
 * other: `if (ready) {} /foo/.test(value)` opens one too, because the brace
 * closed a block. A `!` divides only as a non-null assertion, which it is
 * when what stands before it ended a value itself.
 */
export const endsAValue = (shape: readonly string[]): boolean => {
  const before = shape[shape.length - 1] ?? "";
  if (before === ")") return !closesAHeader(shape);
  if (before === "}") return braceEndedAValue(shape);
  if (before === "!") return endsAValue(shape.slice(0, -1));
  return ENDS_A_VALUE.has(before);
};
