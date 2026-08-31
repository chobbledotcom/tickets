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
import {
  endOfInterpolation,
  endOfRegExp,
  endOfTemplate,
  endsAValue,
  isStepChange,
  isWordPart,
  isWordStart,
} from "./slash.ts";

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
