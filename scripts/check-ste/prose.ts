import { assert } from "@std/assert";
import { Lexer, type Token, type Tokens } from "marked";

interface ProseBlock {
  columns: number[];
  lines: number[];
  text: string;
}

type MarkdownToken =
  | Tokens.Blockquote
  | Tokens.Br
  | Tokens.Code
  | Tokens.Codespan
  | Tokens.Checkbox
  | Tokens.Def
  | Tokens.Del
  | Tokens.Em
  | Tokens.Escape
  | Tokens.Heading
  | Tokens.Hr
  | Tokens.HTML
  | Tokens.Image
  | Tokens.Link
  | Tokens.List
  | Tokens.ListItem
  | Tokens.Paragraph
  | Tokens.Space
  | Tokens.Strong
  | Tokens.Table
  | Tokens.Text;

/** How one kind of Markdown token is read: skipped, walked into, read as
 * prose, or blanked as a machine-owned span. */
type Policy =
  | "omit"
  | "container"
  | "list"
  | "prose"
  | "inline"
  | "text"
  | "span";

const POLICY: Record<MarkdownToken["type"], Policy> = {
  blockquote: "container",
  br: "span",
  checkbox: "span",
  code: "omit",
  codespan: "span",
  def: "omit",
  del: "inline",
  em: "inline",
  escape: "text",
  heading: "prose",
  hr: "omit",
  html: "span",
  image: "inline",
  link: "inline",
  list: "list",
  list_item: "container",
  paragraph: "prose",
  space: "omit",
  strong: "inline",
  table: "omit",
  text: "text",
};

/** A token's policy. Marked only emits the types above for the documents
 * this check reads; a new one crashes loudly at the reader that is not
 * there. */
const policyOf = (token: Token): Policy =>
  POLICY[token.type as MarkdownToken["type"]];

// Marked removes container prefixes, so a container's text is its lines
// without the markers: locate each line of `text` in `source`, in order.
const locateParts = (source: ProseBlock) => {
  let cursor = 0;
  return (text: string): ProseBlock => {
    const lines: number[] = [];
    const columns: number[] = [];
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const index = source.text.indexOf(part, cursor);
      assert(
        index >= 0,
        `Cannot locate Markdown source: ${JSON.stringify(part)}`,
      );
      lines.push(...source.lines.slice(index, index + part.length));
      columns.push(...source.columns.slice(index, index + part.length));
      cursor = index + part.length;
    }
    return { columns, lines, text };
  };
};

/** Every token the policies walk into carries its children and its own
 * text. */
const childrenOf = (token: MarkdownToken): Token[] =>
  (token as unknown as { tokens: Token[] }).tokens;

const textOf = (token: MarkdownToken): string =>
  (token as unknown as { text: string }).text;

const replacement = (source: ProseBlock, text: string): ProseBlock => ({
  columns: Array.from({ length: text.length }, () => source.columns[0]!),
  lines: Array.from({ length: text.length }, () => source.lines[0]!),
  text,
});

const joinText = (parts: ProseBlock[]): ProseBlock => ({
  columns: parts.flatMap((part) => part.columns),
  lines: parts.flatMap((part) => part.lines),
  text: parts.map((part) => part.text).join(""),
});

/** Escape literal marker characters so prose cannot copy an exempt span's identity. */
const escapedText = (source: ProseBlock): ProseBlock =>
  joinText(
    source.text.split("").map((text, index) =>
      replacement(
        {
          columns: [source.columns[index]!],
          lines: [source.lines[index]!],
          text,
        },
        /[%\\]/.test(text) ? `\\${text}` : text,
      ),
    ),
  );

const readTokens = <T>(
  tokens: Token[],
  source: ProseBlock,
  read: (token: MarkdownToken, locate: (text: string) => ProseBlock) => T,
): T[] => {
  const locate = locateParts(source);
  return tokens.map((token) => read(token as MarkdownToken, locate));
};

/** A token's own raw, located by the shared cursor: readers that use the raw
 * call this, and readers that skip the token (a checkbox, a code block)
 * leave the cursor for the next one. */
const readChildren = <T>(
  read: (tokens: Token[], source: ProseBlock) => T,
  token: MarkdownToken,
  locate: (text: string) => ProseBlock,
): T => read(childrenOf(token), locateParts(locate(token.raw))(textOf(token)));

/** The ways one inline Markdown token turns into prose parts. */
const INLINE_READERS: Record<
  "inline" | "text" | "span",
  (token: MarkdownToken, locate: (text: string) => ProseBlock) => ProseBlock
> = {
  inline: (token, locate) =>
    token.type === "link" && !token.raw.startsWith("[")
      ? replacement(locate(token.raw), "%")
      : readChildren(inlineText, token, locate),
  span: (_token, locate) => replacement(locate(_token.raw), "%"),
  text: (token, locate) =>
    escapedText(
      token.type === "escape"
        ? locateParts(locate(token.raw))(textOf(token))
        : locate(token.raw),
    ),
};

/** The prose of one run of inline Markdown. */
const inlineText = (tokens: Token[], source: ProseBlock): ProseBlock =>
  joinText(
    readTokens(tokens, source, (token, locate) =>
      INLINE_READERS[policyOf(token) as "inline" | "text" | "span"](
        token,
        locate,
      ),
    ),
  );

/** One shared reader for paragraph prose and a list item's text: the same
 * inline children, read and normalized. */
const readAsProse = (
  token: MarkdownToken,
  locate: (text: string) => ProseBlock,
): ProseBlock[] => [normalizeInBlock(readChildren(inlineText, token, locate))];

/** The ways one block Markdown token turns into prose blocks. */
const BLOCK_READERS: Record<
  "list" | "container" | "prose" | "text" | "span" | "omit",
  (token: MarkdownToken, locate: (text: string) => ProseBlock) => ProseBlock[]
> = {
  container: (token, locate) => readChildren(blocksFrom, token, locate),
  list: (token, locate) =>
    blocksFrom(
      (token as unknown as Tokens.List).items as unknown as Token[],
      locate(token.raw),
    ),
  omit: () => [],
  prose: readAsProse,
  span: () => [],
  text: readAsProse,
};

const blocksFrom = (tokens: Token[], source: ProseBlock): ProseBlock[] =>
  readTokens(tokens, source, (token, locate) =>
    BLOCK_READERS[policyOf(token) as keyof typeof BLOCK_READERS](token, locate),
  ).flat();

/** Quoted examples are prose only after Markdown excludes code and
 * destinations; blank each one, and collapse whitespace, so the block's
 * identity is stable under rewrapping and exempt-span length changes. */
const normalizeInBlock = (source: ProseBlock): ProseBlock => {
  const parts: ProseBlock[] = [];
  for (const match of source.text.matchAll(/"[^"]*"|\s+|[^\s]/g)) {
    const text = match[0];
    parts.push(
      replacement(
        {
          columns: [source.columns[match.index]!],
          lines: [source.lines[match.index]!],
          text,
        },
        text.startsWith('"') && text.length > 1
          ? "%"
          : /\s/.test(text)
            ? " "
            : text,
      ),
    );
  }
  const joined = joinText(parts);
  const start = joined.text.length - joined.text.trimStart().length;
  const end = joined.text.trimEnd().length;
  return {
    columns: joined.columns.slice(start, end),
    lines: joined.lines.slice(start, end),
    text: joined.text.slice(start, end),
  };
};

export const proseBlocks = (content: string): ProseBlock[] => {
  let text = "";
  let line = 1;
  let column = 1;
  let visualColumn = 0;
  const columns: number[] = [];
  const lines: number[] = [];
  for (const character of content.replace(/\r\n?/g, "\n").split("")) {
    const expanded =
      character === "\t" ? " ".repeat(4 - (visualColumn % 4)) : character;
    text += expanded;
    lines.push(...Array.from({ length: expanded.length }, () => line));
    columns.push(...Array.from({ length: expanded.length }, () => column));
    column++;
    visualColumn += expanded.length;
    if (character === "\n") {
      line++;
      column = 1;
      visualColumn = 0;
    }
  }
  return blocksFrom(Lexer.lex(text), { columns, lines, text });
};
