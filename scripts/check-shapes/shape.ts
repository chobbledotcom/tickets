/**
 * A function body reduced to its shape: every name, number and string becomes
 * one symbol, so two functions that differ only in what they are called and
 * what they mention read as the same run of tokens.
 *
 * This is what `deno task cpd` cannot see. jscpd compares tokens as
 * written, so renaming one copy hides it.
 */

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

/** Where a quoted run ends, given the quote that opened it. Escapes are
 * skipped whole, so a quote inside the text does not close it early. */
const endOfQuoted = (text: string, start: number, quote: string): number => {
  let index = start;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
};

/** Whether a comment opens at `index`. Neither `//` nor `/*` can open a valid
 * pattern, so this is the first question every reader of a `/` asks. */
const opensComment = (text: string, index: number): boolean =>
  text[index] === "/" && /[/*]/.test(text[index + 1] ?? "");

/** Where a comment ends. A line comment runs to the newline, a block comment
 * to its closing pair. */
const endOfComment = (text: string, start: number): number => {
  if (text[start + 1] === "/") {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
};

/**
 * What the token before a slash counts as, when the boundary scan has to tell
 * a divide from a pattern. Whitespace keeps whatever came before it, and
 * anything that ends no value clears it, so an operator puts a pattern back in
 * reach. A word reads as the word itself when the syntax list holds it — so
 * `return` ends no value, the way it does in the token scan — and as `ID`
 * otherwise: a `${…}` never opens with a keyword a pattern could follow.
 */
const valueEndingAt = (
  text: string,
  index: number,
  before: string | undefined,
): string | undefined => {
  const character = text[index] as string;
  if (/\s/.test(character)) return before;
  if (isWordPart(character)) {
    let start = index;
    while (start > 0 && isWordPart(text[start - 1] as string)) start--;
    let end = index;
    while (end < text.length && isWordPart(text[end] as string)) end++;
    const word = text.slice(start, end);
    return SYNTAX_WORDS.has(word) ? word : "ID";
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
 * the head of the body itself. */
const BLOCK_BRACE_AFTER = new Set([
  "",
  ")",
  ";",
  "{",
  "}",
  "=>",
  "do",
  "else",
  "finally",
  "try",
]);

/** Walks back through `shape` to the token in front of the bracket that the
 * bracket at the end closes, or nothing when no opener matches it. */
const tokenBeforeMatchingBrackets =
  (closes: string, opens: string) =>
  (shape: readonly string[]): string | undefined => {
    let depth = 0;
    for (let at = shape.length - 1; at >= 0; at--) {
      if (shape[at] === closes) depth++;
      if (shape[at] !== opens) continue;
      depth--;
      if (depth === 0) return shape[at - 1];
    }
    return;
  };

const wordBeforeParens = tokenBeforeMatchingBrackets(")", "(");
const tokenBeforeBraces = tokenBeforeMatchingBrackets("}", "{");

/**
 * Whether the `)` at the end of `shape` closed an `if`, `while` or `for`
 * header: the word in front of the matching `(` is the only way to tell that
 * bracket from the one that ends a call or a sum.
 */
const closesAHeader = (shape: readonly string[]): boolean =>
  HEADER_WORDS.has(wordBeforeParens(shape) ?? "");

/**
 * Whether the `}` at the end of `shape` closed a value an operator can work
 * on, rather than a block a statement follows: a `{` after an assignment, a
 * bracket, a comma or colon slot, or a value-making keyword holds a value, and
 * any other `{` holds statements. A `}` that closes nothing takes the reading
 * the unmatched `)` does, and divides.
 */
const braceEndedAValue = (shape: readonly string[]): boolean => {
  const opener = tokenBeforeBraces(shape);
  return opener !== undefined ? !BLOCK_BRACE_AFTER.has(opener) : true;
};

/**
 * Whether the token before a slash ends a value, so the slash divides it. A
 * `)` is the one token that depends on what came before it: `total() / 2`
 * divides, but `if (ready) /foo/.test(value)` opens a pattern. A `}` is the
 * other: `if (ready) {} /foo/.test(value)` opens one too, because the brace
 * closed a block.
 */
const endsAValue = (shape: readonly string[]): boolean => {
  const before = shape[shape.length - 1] ?? "";
  if (before === ")") return !closesAHeader(shape);
  if (before === "}") return braceEndedAValue(shape);
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
