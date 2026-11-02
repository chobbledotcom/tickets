/** Read lexical evidence from a Quint module, not the full grammar. The Quint
 *  checker decides the grammar, so this reader only finds the module header,
 *  the state keywords, and the comments. */
export type QuintToken = {
  readonly kind: "identifier" | "number" | "operator" | "string";
  readonly text: string;
  readonly line: number;
};

export type QuintComment = {
  readonly line: number;
  readonly text: string;
};

export type QuintSource = {
  readonly moduleName: string;
  readonly moduleLine: number;
  readonly tokens: readonly QuintToken[];
  readonly comments: readonly QuintComment[];
};

type Lexed = {
  readonly comments: QuintComment[];
  readonly tokens: QuintToken[];
};

type Span =
  | { readonly end: number; readonly kind: "comment" | "other" }
  | {
      readonly end: number;
      readonly kind: "token";
      readonly token: QuintToken["kind"];
    };

const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/u.test(char);
const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_]/u.test(char);
const isDigit = (char: string): boolean => /[0-9]/u.test(char);

/** The end of the text that starts at `from`, or the end of the file. */
const findEnd = (
  content: string,
  from: number,
  marker: string,
  past: number,
): number => {
  const end = content.indexOf(marker, from);
  return end === -1 ? content.length : end + past;
};

/** Scan from one character after `index` until `advance` returns zero. */
const scanEnd = (
  content: string,
  index: number,
  advance: (char: string) => number,
): number => {
  let end = index + 1;
  while (end < content.length) {
    const step = advance(content[end]!);
    if (step === 0) return end;
    end += step;
  }
  return end;
};

const quotedEnd = (content: string, index: number): number =>
  Math.min(
    scanEnd(content, index, (char) =>
      char === '"' ? 0 : char === "\\" ? 2 : 1,
    ) + 1,
    content.length,
  );

const spanAt = (content: string, index: number): Span => {
  const char = content[index]!;
  const next = content[index + 1];
  if (char === "/" && next === "/")
    return { end: findEnd(content, index, "\n", 0), kind: "comment" };
  if (char === "/" && next === "*")
    return { end: findEnd(content, index + 2, "*/", 2), kind: "comment" };
  if (char === '"')
    return { end: quotedEnd(content, index), kind: "token", token: "string" };
  if (isIdentifierStart(char))
    return {
      end: scanEnd(content, index, (char) => (isIdentifierPart(char) ? 1 : 0)),
      kind: "token",
      token: "identifier",
    };
  if (isDigit(char))
    return {
      end: scanEnd(content, index, (char) => (isDigit(char) ? 1 : 0)),
      kind: "token",
      token: "number",
    };
  if (/\s/u.test(char)) return { end: index + 1, kind: "other" };
  return { end: index + 1, kind: "token", token: "operator" };
};

/** One lexical pass. Comments leave the token stream; strings stay whole. */
const lex = (content: string): Lexed => {
  const tokens: QuintToken[] = [];
  const comments: QuintComment[] = [];
  let line = 1;
  let index = 0;
  while (index < content.length) {
    const span = spanAt(content, index);
    const text = content.slice(index, span.end);
    if (span.kind === "comment") comments.push({ line, text });
    if (span.kind === "token") tokens.push({ kind: span.token, line, text });
    line += text.split("\n").length - 1;
    index = span.end;
  }
  return { comments, tokens };
};

const matches = (token: QuintToken | undefined, text: string): boolean =>
  token !== undefined && token.text === text;

/** Read lexical evidence. The Quint checker decides the grammar. */
export const readQuintSource = (file: string, content: string): QuintSource => {
  const { comments, tokens } = lex(content);
  const [keyword, name, open] = tokens;
  if (
    !matches(keyword, "module") ||
    name?.kind !== "identifier" ||
    !matches(open, "{") ||
    !matches(tokens.at(-1), "}")
  ) {
    throw new Error(
      `${file}: The Quint module header or closing brace is invalid.`,
    );
  }
  return { comments, moduleLine: name.line, moduleName: name.text, tokens };
};
