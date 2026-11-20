// effects: pure
/**
 * Markdown to plain text, for one-line previews such as a table cell.
 * A picture goes. A link keeps its words. A heading loses its `#` marks.
 * Every line break becomes one space.
 */

import { Lexer, type Token, type Tokens } from "marked";

/** Token types that add no words to a preview. */
const SILENT_TYPES: ReadonlySet<string> = new Set([
  "def",
  "hr",
  "html",
  "image",
  "space",
]);

/** Token types whose children are separate blocks, so their words need a space
 * between them. Every other container holds inline words that join directly. */
const BLOCK_TYPES: ReadonlySet<string> = new Set(["blockquote", "list_item"]);

const joinText = (tokens: readonly Token[], separator: string): string =>
  tokens.map(tokenText).join(separator);

const isList = (token: Token): token is Tokens.List =>
  token.type === "list" && "items" in token;

const isTable = (token: Token): token is Tokens.Table =>
  token.type === "table" && "header" in token && "rows" in token;

/** The words of one table cell: the cell's own inline tokens. */
const cellText = (cell: Tokens.TableCell): string => joinText(cell.tokens, "");

const tokenText = (token: Token): string => {
  if (SILENT_TYPES.has(token.type)) return "";
  if (token.type === "br") return " ";
  if (isList(token)) return joinText(token.items, " ");
  if (isTable(token)) {
    return [...token.header, ...token.rows.flat()].map(cellText).join(" ");
  }
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return joinText(token.tokens, BLOCK_TYPES.has(token.type) ? " " : "");
  }
  return "text" in token && typeof token.text === "string" ? token.text : "";
};

/** The words of a markdown text on one line, with single spaces. The words
 * keep their written spelling: bold, italic, and code marks go, and a
 * backslash escape gives its character. Raw HTML goes. A mark of punctuation
 * sits against the word before it, also after a removed picture. */
export const markdownToPlainText = (markdown: string): string =>
  joinText(Lexer.lex(markdown), " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
