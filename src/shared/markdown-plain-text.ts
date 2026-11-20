// effects: pure
/**
 * Markdown to plain text, for one-line previews such as a table cell.
 * A picture goes. A link keeps its words. A heading loses its `#` marks.
 * Every line break becomes one space.
 */

import { assert } from "@std/assert";
import { Lexer, type Token, type Tokens } from "marked";
import { childTokens, isTableToken, tableCells } from "#shared/markdown.ts";

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

/** The words of one table cell: the cell's own inline tokens. */
const cellText = (cell: Tokens.TableCell): string => joinText(cell.tokens, "");

const tokenText = (token: Token): string => {
  if (SILENT_TYPES.has(token.type)) return "";
  if (token.type === "br") return " ";
  if (isList(token)) return joinText(token.items, " ");
  if (isTableToken(token)) return tableCells(token).map(cellText).join(" ");
  const children = childTokens(token);
  if (children.length > 0) {
    return joinText(children, BLOCK_TYPES.has(token.type) ? " " : "");
  }
  // Every other token is a leaf that carries its words in `text`. A miss
  // means marked added a token type that this module does not know.
  assert(
    "text" in token && typeof token.text === "string",
    `Markdown token "${token.type}" has no text`,
  );
  return token.text;
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
