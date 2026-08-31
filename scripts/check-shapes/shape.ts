/**
 * A function body reduced to its shape: every name, number and string becomes
 * one symbol, so two functions that differ only in what they are called and
 * what they mention read as the same run of tokens.
 *
 * This is what `deno task cpd` cannot see. jscpd compares tokens as
 * written, so renaming one copy hides it.
 */

import {
  endOfComment,
  endOfQuoted,
  opensComment,
} from "#scripts/quoted-run.ts";
import { SYNTAX_WORDS } from "#scripts/syntax-words.ts";

/** Where a run of text sits in a file, as offsets. */
export interface Span {
  end: number;
  start: number;
}

/** One run of a file to replace before it is shaped, and what to put there. */
export interface Masked extends Span {
  as: string;
}

/**
 * One body with each masked run replaced by what stands for it. The parser says
 * which runs those are: every name somebody chose, and every word a component
 * renders. Masking before tokenising is what lets a keyword used as a name read
 * as a name, and two components that differ only in their wording read alike.
 *
 * The runs must be in order and must not overlap, which is how the parser
 * reports them.
 */
export const maskSpans = (
  source: string,
  body: Span,
  runs: readonly Masked[],
): string => {
  let masked = "";
  let cursor = body.start;
  for (const run of runs) {
    if (run.start < cursor || run.end > body.end) continue;
    masked += source.slice(cursor, run.start) + run.as;
    cursor = run.end;
  }
  return masked + source.slice(cursor, body.end);
};

const isWordStart = (character: string): boolean =>
  /[A-Za-z_$#]/.test(character);

const isWordPart = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);

/** Whether a character doubles into a step operator, `++` or `--`. Written out
 * one of those ends a value, so a slash after it divides. */
const isStepChange = (character: string): boolean =>
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
 * The word in front of the `(` that the `)` at `index` closes, or nothing when
 * nothing matches it or when no word stands there: the boundary scan over raw
 * text asks the same header question the token scan asks over shapes.
 */
const wordBeforeTheParens = (
  text: string,
  index: number,
): string | undefined => {
  let depth = 0;
  for (let at = index; at >= 0; at--) {
    if (text[at] === ")") depth++;
    if (text[at] !== "(") continue;
    depth--;
    if (depth === 0) return wordBefore(text, at);
  }
  return;
};

/** Whether the `)` at `index` closed an `if`, `while` or `for` header. */
const closesAHeaderIn = (text: string, index: number): boolean => {
  const word = wordBeforeTheParens(text, index);
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

/** Where a run that can hold a brace of its own opens at `index` — a quote, a
 * template, a comment or a pattern — and where it ends. Skipping these whole
 * keeps the braces inside them from being counted. */
const endOfNested = (
  text: string,
  index: number,
  before?: string,
): number | null => {
  const character = text[index] as string;
  if (character === '"' || character === "'") {
    return endOfQuoted(text, index + 1, character);
  }
  if (character === "`") return endOfTemplate(text, index + 1);
  if (opensComment(text, index)) return endOfComment(text, index);
  if (character !== "/") return null;
  return ENDS_A_VALUE.has(before ?? "") ? null : endOfRegExp(text, index + 1);
};

/** Just past the `}` closing the `${` that opened at `start`. Braces nest, so
 * only the one that brings the count back to zero ends it. */
const endOfInterpolation = (text: string, start: number): number => {
  let depth = 1;
  let index = start;
  let before: string | undefined;
  while (index < text.length && depth > 0) {
    const nested = endOfNested(text, index, before);
    if (nested !== null) {
      if (!opensComment(text, index)) before = "RE";
      index = nested;
      continue;
    }
    if (text[index] === "{") depth++;
    if (text[index] === "}") depth--;
    before = valueEndingAt(text, index, before);
    index++;
  }
  return index;
};

/**
 * Just past the character that closes a run. `step` reads one character and
 * says where to carry on from, or `null` to say that this one closes the run.
 * An escape is always skipped whole, whatever the run is.
 */
const endOfRun = (
  text: string,
  start: number,
  step: (index: number) => number | null,
): number => {
  let index = start;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    const next = step(index);
    if (next === null) return index + 1;
    index = next;
  }
  return index;
};

/** Just past the backtick closing the template that opened before `start`. */
const endOfTemplate = (text: string, start: number): number =>
  endOfRun(text, start, (index) => {
    if (text[index] === "`") return null;
    return text[index] === "$" && text[index + 1] === "{"
      ? endOfInterpolation(text, index + 2)
      : index + 1;
  });

/**
 * Just past the `/` closing a regular expression, and its flags. A `/` inside
 * a character class does not close one, so `/a[/]b/` is read whole.
 */
const endOfRegExp = (text: string, start: number): number => {
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

/** One step through a body: what it read, and where to carry on. */
interface Step {
  next: number;
  /** The symbols this step read. Empty for whitespace and comments, and more
   * than one for a template, whose interpolations each hold code. */
  tokens: readonly string[];
}

/** Every spelling of one number reads as a single NUM, so `1e+3` and `1000`,
 * or `0XFF` and `255`, cannot give two copies different shapes. The sign after
 * an exponent belongs to the number; a `+` anywhere else does not. */
const NUMBER_PART = /[eE][+-]|[0-9a-fA-FoOxXbBnE._]/y;

/** Whether a number opens at `index`. A leading dot belongs to the number it
 * opens, so `.5` reads as one NUM the way `0.5` does. Nothing else in a masked
 * body puts a digit straight after a dot, because every name is `_` by then. */
const startsNumber = (body: string, index: number): boolean =>
  /[0-9]/.test(body[index] as string) ||
  (body[index] === "." && /[0-9]/.test(body[index + 1] ?? ""));

/**
 * Just past the number that opens at `start`. A decimal point joins the
 * number only while one has not joined already and the read so far holds no
 * exponent, no BigInt `n`, and no radix prefix — so `0x1.toString()`,
 * `1e3.toString()`, and `1n.toString()` read like `1..toString()`, their dot a
 * member access rather than part of the number.
 */
const readNumber = (body: string, start: number): Step => {
  let index = start;
  let dots = 0;
  while (index < body.length) {
    const read = body.slice(start, index);
    const takesADecimal =
      dots === 0 &&
      !/[eE]/.test(read) &&
      !read.endsWith("n") &&
      !/^0[xXoObB]/.test(read);
    if (body[index] === ".") {
      if (!takesADecimal) break;
      dots++;
    }
    NUMBER_PART.lastIndex = index;
    const part = NUMBER_PART.exec(body);
    if (part === null) break;
    index += part[0].length;
  }
  return { next: index, tokens: ["NUM"] };
};

const readWord = (body: string, start: number): Step => {
  let index = start + 1;
  while (index < body.length && isWordPart(body[index] as string)) index++;
  const word = body.slice(start, index);
  return { next: index, tokens: [SYNTAX_WORDS.has(word) ? word : "ID"] };
};

/**
 * A template is one literal plus the code inside its `${…}` groups. Collapsing
 * the whole thing to `STR` would erase that code, and a function whose work
 * happens inside an interpolation would read as a single token.
 */
const readTemplate = (body: string, start: number): Step => {
  const next = endOfTemplate(body, start + 1);
  const tokens: string[] = ["STR"];
  let index = start + 1;
  while (index < next - 1) {
    if (body[index] === "\\") {
      index += 2;
    } else if (body[index] === "$" && body[index + 1] === "{") {
      const close = endOfInterpolation(body, index + 2);
      tokens.push(...shapeOf(body.slice(index + 2, close - 1)));
      index = close;
    } else index++;
  }
  return { next, tokens };
};

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
  (shape: readonly string[]): number => {
    let depth = 0;
    for (let at = shape.length - 1; at >= 0; at--) {
      if (shape[at] === closes) depth++;
      if (shape[at] !== opens) continue;
      depth--;
      if (depth === 0) return at;
    }
    return -1;
  };

const parenOpensAt = matchingOpener(")", "(");
const bracketOpensAt = matchingOpener("]", "[");
const braceOpensAt = matchingOpener("}", "{");

/** The token in front of the bracket the last one matches, or nothing. */
const tokenBeforeMatching =
  (openerAt: (shape: readonly string[]) => number) =>
  (shape: readonly string[]): string | undefined => {
    const at = openerAt(shape);
    return at === -1 ? undefined : shape[at - 1];
  };

const wordBeforeParens = tokenBeforeMatching(parenOpensAt);

/**
 * Whether the `)` at the end of `shape` closed an `if`, `while` or `for`
 * header: the word in front of the matching `(` is the only way to tell that
 * bracket from the one that ends a call or a sum.
 */
const closesAHeader = (shape: readonly string[]): boolean =>
  HEADER_WORDS.has(wordBeforeParens(shape) ?? "");

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
 * brackets crossed whole — to whatever stands before it: a question mark says
 * a ternary's arm, an enclosing object says a property, a value just closed
 * says the same, and anything else says a statement boundary, which is a
 * label's. The clause keywords say a case whatever went before.
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
  if (before === "?") return false;
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
 * Whether the token before a slash ends a value, so the slash divides it. A
 * `)` is the one token that depends on what came before it: `total() / 2`
 * divides, but `if (ready) /foo/.test(value)` opens a pattern. A `}` is the
 * other: `if (ready) {} /foo/.test(value)` opens one too, because the brace
 * closed a block. A `!` divides only as a non-null assertion, which it is
 * when what stands before it ended a value itself.
 */
const endsAValue = (shape: readonly string[]): boolean => {
  const before = shape[shape.length - 1] ?? "";
  if (before === ")") return !closesAHeader(shape);
  if (before === "}") return braceEndedAValue(shape);
  if (before === "!") return endsAValue(shape.slice(0, -1));
  return ENDS_A_VALUE.has(before);
};

/** What sits at `index`, and where whatever follows it begins. The tokens
 *  before it decide whether a `/` divides or opens a pattern. */
const stepAt = (
  body: string,
  index: number,
  shape: readonly string[],
): Step => {
  const character = body[index] as string;
  if (/\s/.test(character)) return { next: index + 1, tokens: [] };
  if (opensComment(body, index)) {
    return { next: endOfComment(body, index), tokens: [] };
  }
  if (character === "/" && !endsAValue(shape)) {
    return { next: endOfRegExp(body, index + 1), tokens: ["RE"] };
  }
  if (character === "`") return readTemplate(body, index);
  if (character === '"' || character === "'") {
    return { next: endOfQuoted(body, index + 1, character), tokens: ["STR"] };
  }
  if (startsNumber(body, index)) return readNumber(body, index);
  if (isWordStart(character)) return readWord(body, index);
  // An arrow is one token, the way it is one in JavaScript, so a block rule
  // can name it: `() => {}` opens a block.
  if (character === "=" && body[index + 1] === ">") {
    return { next: index + 2, tokens: ["=>"] };
  }
  if (isStepChange(character) && body[index + 1] === character) {
    return { next: index + 2, tokens: [character + character] };
  }
  return { next: index + 1, tokens: [character] };
};

/**
 * The shape of one function body. Comments drop out, because a comment is not
 * behaviour; a string, a number and a name each become one symbol; everything
 * else — the punctuation and the words above — stays as written.
 */
export const shapeOf = (body: string): string[] => {
  const shape: string[] = [];
  let index = 0;
  while (index < body.length) {
    const step = stepAt(body, index, shape);
    shape.push(...step.tokens);
    index = step.next;
  }
  return shape;
};
