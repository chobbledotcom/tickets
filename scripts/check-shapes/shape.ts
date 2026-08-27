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

/** One step through a body: what to record, and where to carry on. */
interface Step {
  next: number;
  /** The symbol this step read, or nothing when it read something we drop. */
  token: string | null;
}

const readNumber = (body: string, start: number): Step => {
  let index = start;
  while (
    index < body.length &&
    /[0-9a-fA-Fox._n]/.test(body[index] as string)
  ) {
    index++;
  }
  return { next: index, token: "NUM" };
};

const readWord = (body: string, start: number): Step => {
  let index = start + 1;
  while (index < body.length && isWordPart(body[index] as string)) index++;
  const word = body.slice(start, index);
  return { next: index, token: KEPT_WORDS.has(word) ? word : "ID" };
};

/** What sits at `index`, and where whatever follows it begins. */
const stepAt = (body: string, index: number): Step => {
  const character = body[index] as string;
  if (/\s/.test(character)) return { next: index + 1, token: null };
  if (character === "/" && /[/*]/.test(body[index + 1] ?? "")) {
    return { next: endOfComment(body, index), token: null };
  }
  if (character === '"' || character === "'" || character === "`") {
    return { next: endOfQuoted(body, index + 1, character), token: "STR" };
  }
  if (/[0-9]/.test(character)) return readNumber(body, index);
  if (isWordStart(character)) return readWord(body, index);
  return { next: index + 1, token: character };
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
    const { next, token } = stepAt(body, index);
    if (token !== null) shape.push(token);
    index = next;
  }
  return shape;
};
