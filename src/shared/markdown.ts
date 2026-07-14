/**
 * Markdown rendering for user-authored content.
 *
 * Two layers of defence keep rendered output safe to inject as HTML:
 *  1. Raw HTML in the source is escaped (so `<script>` etc. become text).
 *  2. Link/image URLs are restricted to a safe scheme allowlist, so
 *     `javascript:`/`data:` URLs can't smuggle script execution past step 1.
 */

import { assert } from "@std/assert";
import { Lexer, Marked, type Token, type Tokens } from "marked";
import { once } from "#fp";
import { escapeHtml } from "#templates/layout.tsx";

/** URL schemes permitted in links and images. */
const SAFE_URL_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;

/**
 * True when a link/image URL is safe to render. Relative URLs (no scheme) are
 * allowed; absolute URLs must use a scheme from {@link SAFE_URL_SCHEMES}.
 * Leading ASCII control characters and spaces — which browsers strip before
 * resolving a scheme — are removed first so `java\tscript:` can't sneak through.
 */
export const isSafeUrl = (url: string): boolean => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the C0 control characters and spaces that browsers ignore when resolving a URL scheme is the whole point - it stops a "java<TAB>script:" URL sneaking past the allowlist.
  const cleaned = url.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/);
  return scheme
    ? (SAFE_URL_SCHEMES as readonly string[]).includes(`${scheme[1]}:`)
    : true;
};

/** A link or image token carries an href we want to vet. */
const hasHref = (token: Token): token is Token & { href: string } =>
  (token.type === "link" || token.type === "image") &&
  typeof (token as { href?: unknown }).href === "string";

/** Built on first render, not at module load — `new Marked(...)` compiles
 * marked's tokenizer regexes, so deferring it keeps that work off the cold boot
 * of requests that never render markdown. `once` returns synchronously, so the
 * synchronous render callers are unaffected. */
const md = once(
  () =>
    new Marked({
      renderer: {
        html({ raw }) {
          return escapeHtml(raw);
        },
      },
      walkTokens: (token) => {
        if (hasHref(token) && !isSafeUrl(token.href)) token.href = "";
      },
    }),
);

/** Render markdown to HTML (block-level: paragraphs, lists, etc.). Raw HTML is escaped and unsafe URLs are stripped. */
export const renderMarkdown = (text: string): string =>
  md().parse(text) as string;

/** Inline token types that don't add any HTML structure beyond plain text
 * inside a `<p>`. If a paragraph contains only these, the rendered markdown is
 * just `<p>plain text</p>` — safe to embed inside a `<label>`. Anything else
 * (strong, em, links, lists, headings, code, etc.) counts as "complex". */
const PLAIN_INLINE_TYPES = ["text", "escape", "space", "br"] as const;

/** True when `text` is markdown so simple it renders as nothing more than a
 * single `<p>` of plain text — no bold, italic, links, lists, headings, code,
 * blockquotes, tables, or multiple paragraphs. When this returns true the
 * question can safely be used as the clickable label of its control; when
 * false the question should be rendered as a prose block above the control. */
export const isSimpleMarkdown = (text: string): boolean => {
  const tokens = Lexer.lex(text);
  // Filter out trivial space tokens so a blank line doesn't count as a block.
  const meaningful = tokens.filter((tok) => tok.type !== "space");
  if (meaningful.length !== 1) return false;
  const para = meaningful[0];
  if (para?.type !== "paragraph") return false;
  const inline = (para as Tokens.Paragraph).tokens;
  return inline.every((tok) =>
    (PLAIN_INLINE_TYPES as readonly string[]).includes(tok.type),
  );
};

/** Replace each markdown link whose target starts with `prefix` with its plain
 * text. Used to strip links the viewer isn't allowed to open (e.g. owner-only
 * admin pages) before rendering — a rendered link is a promise that it works,
 * so a viewer who can't follow it gets the words without the link. */
export const withoutLinksTo = (markdown: string, prefix: string): string =>
  rewriteTokens(Lexer.lex(markdown), prefix);

/** Replace child token source in order while preserving every byte between
 * children (markers, whitespace, table pipes, list bullets, and safe markdown). */
type LocatedSourcePart<Part> = {
  index: number;
  part: Part;
  source: string;
};

const locateSourceParts = <Part>(
  raw: string,
  parts: readonly Part[],
  sourceOf: (part: Part) => string,
): LocatedSourcePart<Part>[] => {
  let cursor = 0;
  return parts.map((part) => {
    const source = sourceOf(part);
    const index = raw.indexOf(source, cursor);
    if (index >= 0) cursor = index + source.length;
    return { index, part, source };
  });
};

const rewriteSourceParts = <Part>(
  raw: string,
  parts: readonly LocatedSourcePart<Part>[],
  rewrite: (part: Part) => string,
): string => {
  let cursor = 0;
  return (
    parts.reduce((result, { index, part, source }) => {
      const before = raw.slice(cursor, index);
      cursor = index + source.length;
      return result + before + rewrite(part);
    }, "") + raw.slice(cursor)
  );
};

const rewriteChildren = (
  raw: string,
  children: readonly Token[],
  prefix: string,
  flattenMissing = true,
): string => {
  const parts = locateSourceParts(raw, children, (child) => child.raw);
  if (flattenMissing && parts.some(({ index }) => index < 0)) {
    return rewriteChildren(raw, children.flatMap(leafTokens), prefix, false);
  }
  return rewriteSourceParts(
    raw,
    parts.filter(({ index }) => index >= 0),
    (child) => rewriteToken(child, prefix),
  );
};

const rewriteTable = (token: Tokens.Table, prefix: string): string => {
  const cells = [...token.header, ...token.rows.flat()];
  const parts = locateSourceParts(token.raw, cells, (cell) => cell.text);
  assert(
    parts.every(({ index }) => index >= 0),
    "Markdown table cell not found",
  );
  return rewriteSourceParts(token.raw, parts, (cell) =>
    rewriteChildren(cell.text, cell.tokens, prefix),
  );
};

const isTableToken = (token: Token): token is Tokens.Table =>
  token.type === "table" && "header" in token && "rows" in token;

const childTokens = (token: Token): readonly Token[] => {
  if (isTableToken(token)) {
    return [...token.header, ...token.rows.flat()].flatMap(
      (cell) => cell.tokens,
    );
  }
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
};

/** Deepest parsed tokens in source order. Links stay whole so their complete
 * spelling is replaced; code tokens stay whole so link-looking code advances
 * the source cursor without being changed. */
const leafTokens = (token: Token): Token[] => {
  if (token.type === "link") return [token];
  const children = childTokens(token);
  return children.length > 0 ? children.flatMap(leafTokens) : [token];
};

const rewriteToken = (token: Token, prefix: string): string => {
  if (token.type === "link") {
    if (!token.href.startsWith(prefix)) return token.raw;
    assert(token.tokens, "Markdown link has no parsed text");
    return rewriteChildren(token.text, token.tokens, prefix);
  }
  if (isTableToken(token)) return rewriteTable(token, prefix);
  if (token.type === "list") {
    return rewriteChildren(token.raw, token.items, prefix);
  }
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return rewriteChildren(token.raw, token.tokens, prefix);
  }
  return token.raw;
};

const rewriteTokens = (tokens: readonly Token[], prefix: string): string =>
  tokens.map((token) => rewriteToken(token, prefix)).join("");
