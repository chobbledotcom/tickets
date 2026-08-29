const isQuote = (char: string | undefined): boolean =>
  char === '"' || char === "'" || char === "`";
const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && /[\w$]/.test(char);
/** In TSX text, a word's apostrophe is punctuation, not a string delimiter. */
const isQuoteAt = (content: string, index: number): boolean =>
  isQuote(content[index]) &&
  !(content[index] === "'" && isIdentifierChar(content[index - 1]));

/** Skip a comment at `start`, or return `start` when there is no comment. */
export const skipComment = (content: string, start: number): number => {
  if (content.startsWith("//", start)) {
    const lineEnd = content.indexOf("\n", start);
    return lineEnd === -1 ? content.length : lineEnd;
  }
  if (content.startsWith("/*", start)) {
    const close = content.indexOf("*/", start + 2);
    return close === -1 ? content.length : close + 2;
  }
  return start;
};

type ScanStep = number | "end" | null;

/** Walk text until a caller finds its end: "end" returns one past the
 * character, a number jumps the cursor there, and null lets the for-of
 * advance one character. The for-of drives the walk, so no manual index
 * step exists to freeze. */
const scanText = (
  content: string,
  start: number,
  next: (char: string | undefined, index: number) => ScanStep,
): number => {
  let cursor = start;
  for (const [relative] of content.slice(start).split("").entries()) {
    const index = start + relative;
    if (index < cursor) continue;
    const step = next(content[index], index);
    if (step === "end") return index + 1;
    if (step !== null) cursor = step;
  }
  return content.length;
};

/** Skip one template substitution, including nested braces and strings. */
const skipTemplateSubstitution = (content: string, start: number): number => {
  let depth = 1;
  return scanText(content, start + 2, (char, index) => {
    if (char === "{") {
      depth += 1;
      return null;
    }
    if (char === "}") {
      depth -= 1;
      return depth === 0 ? "end" : null;
    }
    // Code inside a substitution holds its own comments and strings, whose
    // brackets must not count.
    const past = skipCommentOrString(content, index);
    return past !== index ? past : null;
  });
};

/** Skip a string or template literal and return the index after its end. */
export const skipString = (content: string, start: number): number => {
  const quote = content[start];
  return scanText(content, start + 1, (char, index) => {
    if (char === "\\") return index + 2;
    if (char === quote) return "end";
    if (quote === "`" && char === "$" && content[index + 1] === "{") {
      return skipTemplateSubstitution(content, index);
    }
    return null;
  });
};

/** Skip lexical text at `start`, or return `start` for executable code. */
export const skipCommentOrString = (content: string, start: number): number => {
  const pastComment = skipComment(content, start);
  if (pastComment !== start) return pastComment;
  return isQuoteAt(content, start) ? skipString(content, start) : start;
};

/**
 * Punctuation that cannot end an expression, so a `/` straight after it opens
 * a regular expression rather than dividing.
 */
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

/** Words that cannot end an expression either. */
const KEYWORD_BEFORE_REGEX = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "typeof",
  "void",
  "yield",
]);

/** Whether the doubled `+`/`-` ending at `index` is postfix — applied to an
 * operand that ends right before it — so a following `/` divides. */
const isPostfixAt = (content: string, index: number): boolean => {
  if (content.charAt(index - 1) !== content.charAt(index)) return false;
  const before = content.charAt(index - 2);
  return isIdentifierChar(before) || before === ")" || before === "]";
};

/**
 * Whether the `/` at a position opens a regular expression rather than
 * dividing, decided by what precedes it. `consumed` holds the comments already
 * passed, which the scan steps over: a comment is invisible to the code after
 * it, so `x = // note` then `/re/` must read the `=`.
 */
const regexTester = (
  content: string,
  consumed: readonly LexicalSpan[],
): ((start: number) => boolean) => {
  /** The comment an index sits inside, if any. Comments never overlap, so
   * the latest one that started at or before the index is the candidate. */
  const commentAround = (index: number): LexicalSpan | undefined => {
    const candidate = consumed.findLast((span) => span.start <= index);
    return candidate !== undefined && candidate.end > index
      ? candidate
      : undefined;
  };
  const codeCharBefore = (start: number): number => {
    // trimEnd walks back past whitespace without index arithmetic.
    let index = content.slice(0, start).trimEnd().length - 1;
    // Each comment the scan lands in pushes it further left; comments never
    // nest, so one bounded pass per comment settles the position.
    for (const _ of consumed) {
      const around = commentAround(index);
      if (around === undefined) return index;
      index = content.slice(0, around.start).trimEnd().length - 1;
    }
    return index;
  };
  return (start) => {
    const index = codeCharBefore(start);
    if (index < 0) return true;
    const char = content.charAt(index);
    // A postfix ++ or -- ends its operand, so the slash after it divides;
    // every other entry of BEFORE_REGEX leaves a regex open to follow.
    if (BEFORE_REGEX.has(char)) {
      return (char !== "+" && char !== "-") || !isPostfixAt(content, index);
    }
    if (!isIdentifierChar(char)) return false;
    // The word the deciding character ends, read by the regex engine rather
    // than a walked counter, which a mutant could pin in place forever.
    const word = content.slice(0, index + 1).match(/[\w$]+$/);
    return word !== null && KEYWORD_BEFORE_REGEX.has(word[0]!);
  };
};

/** The four ECMAScript line terminators: LF, CR, line separator,
 * paragraph separator. */
const isLineTerminator = (char: string | undefined): boolean =>
  char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";

/** What one regex-body character does to the scan. */
type RegexBodyStep = "close" | "escape" | "reject" | "stay";

const regexBodyCharStep = (
  char: string | undefined,
  inClass: boolean,
): RegexBodyStep => {
  if (isLineTerminator(char)) return "reject";
  if (char === "\\") return "escape";
  if (char === "/" && !inClass) return "close";
  return "stay";
};

/**
 * The index just past a regex body's closing slash. A `/` inside a `[…]` class
 * is literal, so the scan tracks whether it is inside one. A newline means the
 * `/` was division after all, so the caller gets back just past it.
 */
/** The class state after one unescaped body character: a bracket opens or
 * closes the class, anything else leaves it be. */
const inClassAfter = (char: string | undefined, was: boolean): boolean =>
  char === "[" ? true : char === "]" ? false : was;

const regexBodyEnd = (content: string, start: number): number => {
  let inClass = false;
  let escaped = false;
  for (const [relative, char] of content
    .slice(start + 1)
    .split("")
    .entries()) {
    const offset = start + 1 + relative;
    // An escaped character is skipped whole — even a line terminator, and
    // even a bracket, which must not open or close a character class.
    const wasEscaped: boolean = escaped;
    const step: RegexBodyStep = wasEscaped
      ? "stay"
      : regexBodyCharStep(char, inClass);
    escaped = step === "escape";
    if (step === "reject") return start + 1;
    if (step === "close") return offset + 1;
    if (!wasEscaped) inClass = inClassAfter(char, inClass);
  }
  // Falling through means the body ran to the text's end without closing.
  return content.length;
};

/** Skip a regular expression literal at `start`, including its flags, or
 * null when the body hit a newline: the slash was division after all. */
const skipRegex = (content: string, start: number): number | null => {
  const bodyEnd = regexBodyEnd(content, start);
  // A closed body always runs past its opening slash and closing slash, so
  // one past the start alone means the newline rejection fired.
  if (bodyEnd === start + 1) return null;
  for (const [relative] of content.slice(bodyEnd).split("").entries()) {
    const offset = bodyEnd + relative;
    if (!/[a-z]/.test(content.charAt(offset))) return offset;
  }
  return content.length;
};

/** One stretch of non-executable text, and where it sits in the source. */
export interface LexicalSpan {
  end: number;
  kind: "comment" | "regex" | "string";
  start: number;
}

/**
 * Every comment, quoted string, and regular-expression literal, in source
 * order. Walking once from the top is what keeps a `//` inside a string from
 * reading as a comment, and vice versa — so callers that care about only one
 * kind still have to walk them all. A regex body is not executable code, so
 * text scanners must blank it like a comment.
 */
export function* lexicalSpans(content: string): Generator<LexicalSpan> {
  // The comments passed so far, which the regex test steps back over.
  const consumed: LexicalSpan[] = [];
  const startsRegex = regexTester(content, consumed);
  // The for-of drives the walk; the cursor only jumps past a whole span, so
  // no manual step exists for a mutant to freeze.
  let cursor = 0;
  for (const [index, char] of content.split("").entries()) {
    if (index < cursor) continue;
    const pastComment = skipComment(content, index);
    if (pastComment !== index) {
      const span: LexicalSpan = {
        end: pastComment,
        kind: "comment",
        start: index,
      };
      consumed.push(span);
      yield span;
      cursor = pastComment;
      continue;
    }
    if (isQuoteAt(content, index)) {
      const end = skipString(content, index);
      yield { end, kind: "string", start: index };
      cursor = end;
    } else if (char === "/" && startsRegex(index)) {
      const end = skipRegex(content, index);
      if (end !== null) {
        yield { end, kind: "regex", start: index };
        cursor = end;
      }
      // A null end means the body hit a newline and the slash divided: no
      // span, and the walk resumes with the for-of itself.
    }
  }
}

/** Just the comments, in source order — the other kinds are walked but not
 * yielded. */
export function* commentSpans(content: string): Generator<LexicalSpan> {
  for (const span of lexicalSpans(content)) {
    if (span.kind === "comment") yield span;
  }
}

/** Replace comments, regex bodies, and optionally strings with spaces while
 * keeping offsets. */
export const blankSpans = (content: string, blankStrings: boolean): string => {
  const chars = content.split("");
  for (const span of lexicalSpans(content)) {
    if (span.kind === "string" && !blankStrings) continue;
    for (const [offset, char] of content
      .slice(span.start, span.end)
      .split("")
      .entries()) {
      chars[span.start + offset] = char === "\n" ? "\n" : " ";
    }
  }
  return chars.join("");
};
