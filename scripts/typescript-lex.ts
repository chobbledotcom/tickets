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
  if (content[start] === "/" && content[start + 1] === "/") {
    let index = start;
    while (index < content.length && content[index] !== "\n") index += 1;
    return index;
  }
  if (content[start] === "/" && content[start + 1] === "*") {
    let index = start + 2;
    while (
      index < content.length &&
      !(content[index] === "*" && content[index + 1] === "/")
    ) {
      index += 1;
    }
    return Math.min(index + 2, content.length);
  }
  return start;
};

type ScanStep = number | "end" | null;

/** Walk text until a caller finds its end, skipping nested quoted text. */
const scanText = (
  content: string,
  start: number,
  next: (char: string | undefined, index: number) => ScanStep,
): number => {
  let index = start;
  while (index < content.length) {
    const step = next(content[index], index);
    if (step === "end") return index + 1;
    if (step !== null) {
      index = step;
      continue;
    }
    const pastComment = skipComment(content, index);
    if (pastComment !== index) {
      index = pastComment;
      continue;
    }
    index = isQuoteAt(content, index) ? skipString(content, index) : index + 1;
  }
  return index;
};

/** Skip one template substitution, including nested braces and strings. */
const skipTemplateSubstitution = (content: string, start: number): number => {
  let depth = 1;
  return scanText(content, start + 2, (char, index) => {
    if (char === "{") {
      depth += 1;
      return index + 1;
    }
    if (char !== "}") return null;
    depth -= 1;
    return depth === 0 ? "end" : index + 1;
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
    return index + 1;
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

/**
 * Asks, of one file's text, whether the `/` at a position opens a regular
 * expression rather than dividing — decided by what precedes it. Without this a
 * regex holding a quote — say `/viewBox="([^"]+)"/` — reads as an unterminated
 * string, and every comment and string after it is found in the wrong place.
 *
 * `commentStarts` maps each consumed comment's final character to where it
 * opened, so the scan can step back over one: a comment is invisible to the
 * code that follows it, and `x = // note` then `/re/` must read the `=`.
 */
const regexTester = (
  content: string,
  commentStarts: ReadonlyMap<number, number>,
): ((start: number) => boolean) => {
  const codeCharBefore = (start: number): number => {
    let index = start - 1;
    for (;;) {
      while (index >= 0 && /\s/.test(content.charAt(index))) index -= 1;
      const commentStart = commentStarts.get(index);
      if (commentStart === undefined) return index;
      index = commentStart - 1;
    }
  };
  return (start) => {
    const index = codeCharBefore(start);
    if (index < 0) return true;
    const char = content.charAt(index);
    if (BEFORE_REGEX.has(char)) return true;
    if (!isIdentifierChar(char)) return false;
    let wordStart = index;
    while (wordStart >= 0 && isIdentifierChar(content[wordStart])) {
      wordStart -= 1;
    }
    return KEYWORD_BEFORE_REGEX.has(content.slice(wordStart + 1, index + 1));
  };
};

/**
 * The index just past a regex body's closing slash. A `/` inside a `[…]` class
 * is literal, so the scan tracks whether it is inside one. A newline means the
 * `/` was division after all, so the caller gets back just past it.
 */
const regexBodyEnd = (content: string, start: number): number => {
  let index = start + 1;
  let inClass = false;
  while (index < content.length) {
    const char = content[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return start + 1;
    if (char === "/" && !inClass) return index + 1;
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    index += 1;
  }
  return index;
};

/** Skip a regular expression literal at `start`, including its flags. */
const skipRegex = (content: string, start: number): number => {
  let index = regexBodyEnd(content, start);
  while (index < content.length && /[a-z]/.test(content.charAt(index))) {
    index += 1;
  }
  return index;
};

/** One stretch of non-executable text, and where it sits in the source. */
export interface LexicalSpan {
  end: number;
  kind: "comment" | "string";
  start: number;
}

/**
 * Every comment and quoted string, in source order. Walking once from the top
 * is what keeps a `//` inside a string from reading as a comment, and vice
 * versa — so callers that care about only one kind still have to walk both.
 */
export function* lexicalSpans(content: string): Generator<LexicalSpan> {
  // Where each comment consumed so far opened, keyed by its last character, so
  // the regex test can step back over one.
  const commentStarts = new Map<number, number>();
  const startsRegex = regexTester(content, commentStarts);
  let index = 0;
  while (index < content.length) {
    const pastComment = skipComment(content, index);
    if (pastComment !== index) {
      yield { end: pastComment, kind: "comment", start: index };
      commentStarts.set(pastComment - 1, index);
      index = pastComment;
      continue;
    }
    if (isQuoteAt(content, index)) {
      const end = skipString(content, index);
      yield { end, kind: "string", start: index };
      index = end;
      continue;
    }
    if (content[index] === "/" && startsRegex(index)) {
      index = skipRegex(content, index);
      continue;
    }
    index += 1;
  }
}

/** Replace comments and optionally strings with spaces while keeping offsets. */
export const blankSpans = (content: string, blankStrings: boolean): string => {
  const output = content.split("");
  for (const span of lexicalSpans(content)) {
    if (span.kind === "string" && !blankStrings) continue;
    for (let index = span.start; index < span.end; index += 1) {
      if (output[index] !== "\n") output[index] = " ";
    }
  }
  return output.join("");
};
