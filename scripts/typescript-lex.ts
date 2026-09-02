import { isOneOf } from "#fp";
import { SYNTAX_WORDS } from "#scripts/syntax-words.ts";
import {
  endsAValue,
  isStepChange,
  isWordPart,
  isWordStart,
} from "#scripts/typescript-lex/slash.ts";

/** The character at `index` as one whole letter, so a wider one is one item
 * to the scanner rather than two surrogate halves. */
const charAt = (content: string, index: number): string =>
  String.fromCodePoint(content.codePointAt(index)!);

/** Whether `character` belongs to the word an apostrophe may close. A
 * surrogate half belongs, so a wider letter joins its word too. */
const isWordUnit = (character: string): boolean =>
  isWordPart(character) || (character >= "\uD800" && character <= "\uDFFF");

/** In TSX text, a word's apostrophe is punctuation, not a string
 * delimiter. The one exception is a keyword a literal can start after:
 * `return'…'` is a tightly-spelled string, `It's` is text. */
const isQuoteAt = (content: string, index: number): boolean => {
  const quote = content[index];
  if (quote === '"' || quote === "`") return true;
  if (quote !== "'") return false;
  let start = index;
  while (start > 0 && isWordUnit(content[start - 1]!)) start--;
  const word = content.slice(start, index);
  return word === "" || SYNTAX_WORDS.has(word);
};

const isLineTerminator = isOneOf(["\n", "\r", "\u2028", "\u2029"]);

/** Skip a comment at `start`, or return `start` when none starts there. */
export const skipComment = (content: string, start: number): number => {
  if (content.startsWith("//", start)) {
    for (let index = start + 2; index < content.length; index++) {
      const character = content[index] as string;
      if (character === "\r" && content[index + 1] === "\n") return index + 1;
      if (isLineTerminator(character)) return index;
    }
    return content.length;
  }
  if (content.startsWith("/*", start)) {
    const close = content.indexOf("*/", start + 2);
    return close === -1 ? content.length : close + 2;
  }
  return start;
};

type RunMove = "close" | number | null;

/** Walk one escaped run until its reader closes it or jumps over nested code. */
const runEnd = (
  content: string,
  start: number,
  moveAt: (index: number) => RunMove,
): number => {
  let index = start + 1;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
    } else {
      const move = moveAt(index);
      if (move === "close") return index + 1;
      index = move ?? index + 1;
    }
  }
  return content.length;
};

const quotedEnd = (content: string, start: number, quote: string): number =>
  runEnd(content, start, (index) =>
    content[index] === quote ? "close" : null,
  );

type RegexBodyStep = "close" | "escape" | "reject" | "stay";

const regexBodyStep = (
  character: string | undefined,
  inClass: boolean,
): RegexBodyStep => {
  if (isLineTerminator(character)) return "reject";
  if (character === "\\") return "escape";
  if (character === "/" && !inClass) return "close";
  return "stay";
};

const classAfter = (
  character: string | undefined,
  inClass: boolean,
): boolean => (character === "[" ? true : character === "]" ? false : inClass);

const regexBodyEnd = (content: string, start: number): number => {
  let inClass = false;
  let escaped = false;
  for (const [relative, character] of content
    .slice(start + 1)
    .split("")
    .entries()) {
    const offset = start + 1 + relative;
    const wasEscaped: boolean = escaped;
    const step: RegexBodyStep = wasEscaped
      ? "stay"
      : regexBodyStep(character, inClass);
    escaped = step === "escape";
    if (step === "reject") return start + 1;
    if (step === "close") return offset + 1;
    if (!wasEscaped) inClass = classAfter(character, inClass);
  }
  return content.length;
};

/** Just past a regex and its flags, or null when the slash divides. */
const regexEnd = (content: string, start: number): number | null => {
  const bodyEnd = regexBodyEnd(content, start);
  if (bodyEnd === start + 1) return null;
  for (const [relative] of content.slice(bodyEnd).split("").entries()) {
    const offset = bodyEnd + relative;
    if (!/[a-z]/.test(content[offset] as string)) return offset;
  }
  return content.length;
};

/** One stretch of source text that executable code does not read directly. */
export interface LexicalSpan {
  end: number;
  kind: "comment" | "regex" | "string";
  start: number;
}

interface Step {
  context?: readonly string[];
  next: number;
  span?: LexicalSpan;
  tokens: readonly string[];
}

type StepReader<Result extends Step | null> = (
  content: string,
  index: number,
  context: readonly string[],
) => Result;

interface ScanResult {
  end: number;
  spans: LexicalSpan[];
  tokens: string[];
}

const NUMBER_PART = /[eE][+-]|[0-9a-fA-FoOxXbBnE._]/y;

const startsNumber = (content: string, index: number): boolean =>
  /[0-9]/.test(content[index] as string) ||
  (content[index] === "." && /[0-9]/.test(content[index + 1] ?? ""));

const numberStep = (content: string, start: number): Step => {
  let index = start;
  let dots = 0;
  while (index < content.length) {
    const read = content.slice(start, index);
    const takesDecimal =
      dots === 0 &&
      !/[eE]/.test(read) &&
      !read.endsWith("n") &&
      !/^0[xXoObB]/.test(read);
    if (content[index] === ".") {
      if (!takesDecimal) break;
      dots++;
    }
    NUMBER_PART.lastIndex = index;
    const part = NUMBER_PART.exec(content);
    if (part === null) break;
    index += part[0].length;
  }
  return { next: index, tokens: ["NUM"] };
};

/** Read one source word as a keyword or a chosen name. */
const wordStep = (
  content: string,
  start: number,
  context: readonly string[],
): Step => {
  let index = start;
  while (index < content.length) {
    const character = charAt(content, index);
    if (index > start && !isWordPart(character)) break;
    index += character.length;
  }
  const word = content.slice(start, index);
  return {
    next: index,
    tokens: [SYNTAX_WORDS.has(word) && context.at(-1) !== "." ? word : "ID"],
  };
};

/** Read a template and the executable code in each interpolation. */
function templateStep(content: string, start: number): Step {
  const tokens: string[] = ["STR"];
  const end = runEnd(content, start, (index) => {
    if (content[index] === "`") return "close";
    if (content[index] === "$" && content[index + 1] === "{") {
      const group = scanCode(content, index + 2, true, ["="]);
      tokens.push(...group.tokens);
      return group.end;
    }
    return null;
  });
  return {
    context: ["STR"],
    next: end,
    span: { end, kind: "string", start },
    tokens,
  };
}

const commentStep = (content: string, index: number): Step | null => {
  const end = skipComment(content, index);
  return end === index
    ? null
    : {
        next: end,
        span: { end, kind: "comment", start: index },
        tokens: [],
      };
};

/** A JSX closing tag, or a comparison's pattern: `</name>` is a tag only
 * when no slash follows the `>`, because that slash would be the pattern's
 * own closing one. */
const startsJsxClose = (content: string, index: number): boolean =>
  /^\/(?:[$_.:\-\p{ID_Continue}]+\s*)?>(?!\/)/u.test(content.slice(index));

const regexStep: StepReader<Step | null> = (content, index, context) => {
  if (
    content[index] !== "/" ||
    (content[index - 1] === "<" && startsJsxClose(content, index)) ||
    endsAValue(context)
  ) {
    return null;
  }
  const end = regexEnd(content, index);
  return end === null
    ? { context: ["ID"], next: index + 1, tokens: ["/"] }
    : {
        next: end,
        span: { end, kind: "regex", start: index },
        tokens: ["RE"],
      };
};

const stringStep = (content: string, index: number): Step | null => {
  if (!isQuoteAt(content, index)) return null;
  const character = content[index] as string;
  if (character === "`") return templateStep(content, index);
  const end = quotedEnd(content, index, character);
  return {
    next: end,
    span: { end, kind: "string", start: index },
    tokens: ["STR"],
  };
};

const stepAt: StepReader<Step> = (content, index, context) => {
  const character = charAt(content, index);
  if (/\s/.test(character)) {
    return { next: index + character.length, tokens: [] };
  }
  const lexical =
    commentStep(content, index) ??
    regexStep(content, index, context) ??
    stringStep(content, index);
  if (lexical !== null) return lexical;
  if (startsNumber(content, index)) return numberStep(content, index);
  if (isWordStart(character)) return wordStep(content, index, context);
  if (character === "=" && content[index + 1] === ">") {
    return { next: index + 2, tokens: ["=>"] };
  }
  if (isStepChange(character) && content[index + 1] === character) {
    return { next: index + 2, tokens: [character + character] };
  }
  return { next: index + character.length, tokens: [character] };
};

const nextDepth = (
  stopsAtBrace: boolean,
  depth: number,
  character: string,
  oneCharacterStep: boolean,
): number => {
  if (!stopsAtBrace || !oneCharacterStep) return depth;
  if (character === "{") return depth + 1;
  if (character === "}") return depth - 1;
  return depth;
};

/** Scan executable code, optionally up to one interpolation's closing brace. */
function scanCode(
  content: string,
  start: number,
  stopsAtBrace: boolean,
  initialContext: readonly string[] = [],
): ScanResult {
  const context = [...initialContext];
  const spans: LexicalSpan[] = [];
  const tokens: string[] = [];
  let depth = 0;
  let index = start;
  while (index < content.length) {
    const character = content[index] as string;
    if (stopsAtBrace && character === "}" && depth === 0) {
      return { end: index + 1, spans, tokens };
    }
    const step = stepAt(content, index, context);
    tokens.push(...step.tokens);
    context.push(...(step.context ?? step.tokens));
    if (step.span !== undefined) spans.push(step.span);
    depth = nextDepth(stopsAtBrace, depth, character, step.next === index + 1);
    index = step.next;
  }
  return { end: content.length, spans, tokens };
}

/** Skip a string or template, or return `start` when no string starts there. */
export const skipString = (content: string, start: number): number => {
  const quote = content[start];
  if (!isQuoteAt(content, start) || quote === undefined) return start;
  return quote === "`"
    ? templateStep(content, start).next
    : quotedEnd(content, start, quote);
};

/** Skip a comment or string, or return `start` for executable code. */
export const skipCommentOrString = (content: string, start: number): number => {
  const pastComment = skipComment(content, start);
  return pastComment === start ? skipString(content, start) : pastComment;
};

/** Every comment, string, template, and regular expression in source order. */
export function* lexicalSpans(content: string): Generator<LexicalSpan> {
  yield* scanCode(content, 0, false).spans;
}

/** Just the comments, after the same complete lexical scan. */
export function* commentSpans(content: string): Generator<LexicalSpan> {
  for (const span of lexicalSpans(content)) {
    if (span.kind === "comment") yield span;
  }
}

/** Replace each lexical span while source outside every span stays unchanged. */
export const mapLexicalSpans = (
  content: string,
  replace: (run: string, span: LexicalSpan) => string,
): string => {
  let result = "";
  let cursor = 0;
  for (const span of lexicalSpans(content)) {
    result += content.slice(cursor, span.start);
    result += replace(content.slice(span.start, span.end), span);
    cursor = span.end;
  }
  return result + content.slice(cursor);
};

/** Replace lexical spans with spaces while every line offset stays fixed. */
export const blankSpans = (content: string, blankStrings: boolean): string => {
  const characters = content.split("");
  for (const span of lexicalSpans(content)) {
    if (span.kind === "string" && !blankStrings) continue;
    for (let index = span.start; index < span.end; index++) {
      const character = content[index] as string;
      characters[index] = isLineTerminator(character) ? character : " ";
    }
  }
  return characters.join("");
};

/** One body with every chosen word and literal reduced to its shape token. */
export const shapeOf = (content: string): string[] =>
  scanCode(content, 0, false).tokens;
