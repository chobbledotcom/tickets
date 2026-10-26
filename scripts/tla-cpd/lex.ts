export type SourceLocation = { line: number; column: number; position: number };
export type TlaToken = {
  kind: "identifier" | "number" | "string" | "operator";
  text: string;
  start: SourceLocation;
  end: SourceLocation;
};

const operators = [
  "-+->",
  "::=",
  "<=>",
  "...",
  "<<<",
  ">>>",
  "|->",
  "::",
  "==",
  "=>",
  "<=",
  ">=",
  "/=",
  "~>",
  "->",
  "<-",
  "<<",
  ">>",
  "[]",
  "<>",
  "/\\",
  "\\/",
  "..",
  "@@",
  "++",
  "--",
  "**",
  "//",
  "^^",
  "&&",
  "||",
  "|-",
  "|=",
  "-.",
  "!!",
  "??",
  "##",
  "$$",
  "%%",
  "~~",
  "\\X",
  ":=",
  "<:",
  ":>",
  "^+",
  "^*",
  "^#",
  "(+)",
  "(-)",
  "(.)",
  "(/)",
  "(\\X)",
  "\\",
].sort((left, right) => right.length - left.length);
const identifier = /^[\p{N}_]*[\p{L}_][\p{L}\p{M}\p{N}_]*/u;
const number = /^(?:\d+\.\d+(?:[eE][+-]?\d+)?|\d+)/;
const radix = /^\\(?:[bB][01]+|[oO][0-7]+|[hH][0-9a-fA-F]+)/;
const namedOperator = /^\\[A-Za-z]+/;
const punctuation = /^[!#$%&'()*+,\-./:;<=>?@[\]^`{|}~¬∧∨≠≤≥∈∉⊆⊂∪∩∀∃⇒⇔×]/u;

type Cursor = SourceLocation & { source: string };

const location = ({ column, line, position }: Cursor): SourceLocation => ({
  column,
  line,
  position,
});

const fail = (cursor: Cursor, message: string): never => {
  throw new Error(`${message} at ${cursor.line}:${cursor.column}`);
};

const newlineWidth = (cursor: Cursor, end: number): number => {
  if (cursor.source[cursor.position] === "\r") {
    return cursor.position + 1 < end &&
      cursor.source[cursor.position + 1] === "\n"
      ? 2
      : 1;
  }
  return cursor.source[cursor.position] === "\n" ? 1 : 0;
};

const advance = (cursor: Cursor, length: number): void => {
  const end = cursor.position + length;
  while (cursor.position < end) {
    const width = newlineWidth(cursor, end);
    if (width === 0) {
      cursor.position++;
      cursor.column++;
    } else {
      cursor.position += width;
      cursor.line++;
      cursor.column = 1;
    }
  }
};

const skipBlockComment = (cursor: Cursor): void => {
  let depth = 1;
  advance(cursor, 2);
  while (depth > 0) {
    if (cursor.position === cursor.source.length) {
      fail(cursor, "Unterminated block comment");
    }
    if (cursor.source.startsWith("(*", cursor.position)) {
      depth++;
      advance(cursor, 2);
    } else if (cursor.source.startsWith("*)", cursor.position)) {
      depth--;
      advance(cursor, 2);
    } else {
      advance(cursor, Math.max(1, newlineWidth(cursor, cursor.source.length)));
    }
  }
};

const skipIgnored = (cursor: Cursor, rest: string): boolean => {
  const whitespace = /^\s+/.exec(rest)?.[0];
  if (whitespace) {
    advance(cursor, whitespace.length);
  } else if (rest.startsWith("\\*")) {
    const end = rest.search(/[\r\n]/);
    advance(cursor, end < 0 ? rest.length : end);
  } else if (rest.startsWith("(*")) {
    skipBlockComment(cursor);
  } else {
    return false;
  }
  return true;
};

const readString = (cursor: Cursor, rest: string): string => {
  let length = 1;
  while (rest[length] !== '"') {
    const character = rest[length];
    if (character === undefined || character === "\r" || character === "\n") {
      fail(cursor, "Unterminated string literal");
    }
    if (character === "\\") {
      length++;
      if (!/[tnfr"\\]/.test(rest[length] ?? "")) {
        fail(cursor, "Invalid string escape");
      }
    }
    length++;
  }
  return rest.slice(0, length + 1);
};

const finishToken = (
  cursor: Cursor,
  kind: TlaToken["kind"],
  text: string,
): TlaToken => {
  const start = location(cursor);
  advance(cursor, text.length);
  return { end: location(cursor), kind, start, text };
};

const readToken = (cursor: Cursor, rest: string): TlaToken => {
  if (rest.startsWith("*)")) {
    fail(cursor, "Unexpected block comment terminator");
  }
  if (rest.startsWith('"')) {
    return finishToken(cursor, "string", readString(cursor, rest));
  }
  const name = identifier.exec(rest)?.[0];
  if (name) return finishToken(cursor, "identifier", name);
  const numeric = radix.exec(rest)?.[0] ?? number.exec(rest)?.[0];
  if (numeric) return finishToken(cursor, "number", numeric);
  const text =
    /^(?:-{4,}|={4,})/.exec(rest)?.[0] ??
    namedOperator.exec(rest)?.[0] ??
    operators.find((candidate) => rest.startsWith(candidate)) ??
    punctuation.exec(rest)?.[0] ??
    fail(cursor, "Unrecognised TLA character");
  return finishToken(cursor, "operator", text);
};

export const tokenizeTla = (source: string): TlaToken[] => {
  const cursor: Cursor = { column: 1, line: 1, position: 0, source };
  const tokens: TlaToken[] = [];
  while (cursor.position < source.length) {
    const rest = source.slice(cursor.position);
    if (skipIgnored(cursor, rest)) continue;
    tokens.push(readToken(cursor, rest));
  }
  return tokens;
};
