/**
 * A function body reduced to its shape: every name, number and string becomes
 * one symbol, so two functions that differ only in what they are called and
 * what they mention read as the same run of tokens.
 *
 * This is what `deno task cpd` cannot see. jscpd compares the tokens as
 * written, so renaming one copy hides it.
 */

/** Words that carry meaning of their own, so they survive normalisation. A
 * name outside this set becomes `ID`, because a rename must not change a
 * shape. */
const KEPT_WORDS = new Set([
  "as",
  "await",
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "satisfies",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

/** Where a run of text sits in a file, as offsets. */
export interface Span {
  end: number;
  start: number;
}

/**
 * One body with every run of JSX text replaced by an empty string, so the words
 * a component renders read as one literal rather than as names. Text that is
 * only whitespace goes altogether: JSX drops it, and keeping it would make the
 * shape change when `deno fmt` rewraps the markup.
 */
export const maskJsxText = (
  source: string,
  body: Span,
  spans: readonly Span[],
): string => {
  let masked = "";
  let cursor = body.start;
  for (const span of spans) {
    if (span.start < cursor || span.end > body.end) continue;
    const text = source.slice(span.start, span.end);
    masked += source.slice(cursor, span.start) + (/\S/.test(text) ? '""' : "");
    cursor = span.end;
  }
  return masked + source.slice(cursor, body.end);
};

const isWordStart = (character: string): boolean =>
  /[A-Za-z_$#]/.test(character);

const isWordPart = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);

/** Where a quoted run ends, given the quote that opened it. Escapes are
 * skipped whole, so a quote inside the text does not close it early. */
const endOfQuoted = (text: string, start: number, quote: string): number => {
  let index = start;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
};

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

/** Where a quote or a template opening at `index` ends, or nothing when one
 * does not open there. Skipping these whole keeps the braces and backticks
 * inside them from being counted. */
const endOfNested = (text: string, index: number): number | null => {
  const character = text[index] as string;
  if (character === '"' || character === "'") {
    return endOfQuoted(text, index + 1, character);
  }
  return character === "`" ? endOfTemplate(text, index + 1) : null;
};

/** Just past the `}` closing the `${` that opened at `start`. Braces nest, so
 * only the one that brings the count back to zero ends it. */
const endOfInterpolation = (text: string, start: number): number => {
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const nested = endOfNested(text, index);
    if (nested !== null) {
      index = nested;
      continue;
    }
    if (text[index] === "{") depth++;
    if (text[index] === "}") depth--;
    index++;
  }
  return index;
};

/** Just past the backtick closing the template that opened before `start`. */
const endOfTemplate = (text: string, start: number): number => {
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") index += 2;
    else if (character === "`") return index + 1;
    else if (character === "$" && text[index + 1] === "{") {
      index = endOfInterpolation(text, index + 2);
    } else index++;
  }
  return index;
};

/**
 * Just past the `/` closing a regular expression, and its flags. A `/` inside
 * a character class does not close one, so `/a[/]b/` is read whole.
 */
const endOfRegExp = (text: string, start: number): number => {
  let index = start;
  let inClass = false;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "/" && !inClass) break;
    if (character === "[") inClass = true;
    if (character === "]") inClass = false;
    index++;
  }
  index++;
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

const readNumber = (body: string, start: number): Step => {
  let index = start;
  while (index < body.length) {
    NUMBER_PART.lastIndex = index;
    const part = NUMBER_PART.exec(body);
    if (part === null) break;
    index += part[0].length;
  }
  return { next: index, tokens: ["NUM"] };
};

/**
 * Whether the word ending at `index` is being used as a name rather than as
 * syntax. A word after a dot is a property, and a word before a colon is a key
 * — `row.type` and `{ type: … }` are both names somebody chose, so they read
 * as `ID` the same way `row.kind` does.
 */
const isUsedAsName = (body: string, start: number, index: number): boolean => {
  if (body.slice(0, start).trimEnd().endsWith(".")) return true;
  return body.slice(index).trimStart().startsWith(":");
};

const readWord = (body: string, start: number): Step => {
  let index = start + 1;
  while (index < body.length && isWordPart(body[index] as string)) index++;
  const word = body.slice(start, index);
  const kept = KEPT_WORDS.has(word) && !isUsedAsName(body, start, index);
  return { next: index, tokens: [kept ? word : "ID"] };
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

/** What sits at `index`, and where whatever follows it begins. The token
 *  before it decides whether a `/` divides or opens a pattern. */
const stepAt = (body: string, index: number, before?: string): Step => {
  const character = body[index] as string;
  if (/\s/.test(character)) return { next: index + 1, tokens: [] };
  if (character === "/" && /[/*]/.test(body[index + 1] ?? "")) {
    return { next: endOfComment(body, index), tokens: [] };
  }
  if (character === "/" && !ENDS_A_VALUE.has(before ?? "")) {
    return { next: endOfRegExp(body, index + 1), tokens: ["RE"] };
  }
  if (character === "`") return readTemplate(body, index);
  if (character === '"' || character === "'") {
    return { next: endOfQuoted(body, index + 1, character), tokens: ["STR"] };
  }
  if (/[0-9]/.test(character)) return readNumber(body, index);
  if (isWordStart(character)) return readWord(body, index);
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
    const step = stepAt(body, index, shape[shape.length - 1]);
    shape.push(...step.tokens);
    index = step.next;
  }
  return shape;
};
