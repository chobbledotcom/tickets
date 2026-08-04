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
import { escapeHtml } from "#shared/jsx/escape-html.ts";

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

/** A link target to strip: either a URL prefix (the common case) or a predicate
 * for patterns that can't be expressed as a single prefix (e.g. an owner-only
 * tab whose URL also starts with a shared base the viewer CAN open). */
type LinkMatcher = string | ((href: string) => boolean);

/** True when `href` should be demoted to plain text. A string matcher is a
 * prefix check; a function matcher is called directly. */
const linkMatches = (matcher: LinkMatcher, href: string): boolean =>
  typeof matcher === "string" ? href.startsWith(matcher) : matcher(href);

/** Replace each markdown link whose target matches `matcher` with its plain
 * text. Used to strip links the viewer isn't allowed to open (e.g. owner-only
 * admin pages) before rendering — a rendered link is a promise that it works,
 * so a viewer who can't follow it gets the words without the link. */
export const withoutLinksTo = (
  markdown: string,
  matcher: LinkMatcher,
): string => rewriteTokens(Lexer.lex(markdown), matcher);

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
  matcher: LinkMatcher,
  flattenMissing = true,
): string => {
  const parts = locateSourceParts(raw, children, (child) => child.raw);
  if (flattenMissing && parts.some(({ index }) => index < 0)) {
    return rewriteChildren(raw, children.flatMap(leafTokens), matcher, false);
  }
  return rewriteSourceParts(
    raw,
    parts.filter(({ index }) => index >= 0),
    (child) => rewriteToken(child, matcher),
  );
};

const rewriteTable = (token: Tokens.Table, matcher: LinkMatcher): string => {
  const cells = [...token.header, ...token.rows.flat()];
  const parts = locateSourceParts(token.raw, cells, (cell) => cell.text);
  // Marked normalizes escaped pipes (`\|` → `|`) in cell.text, so a cell whose
  // source has an escaped pipe won't be found in token.raw. Skip those cells
  // (their raw source is preserved by rewriteSourceParts' gap handling) rather
  // than crashing — the table still renders, and any link in a matched cell is
  // still demoted.
  return rewriteSourceParts(
    token.raw,
    parts.filter(({ index }) => index >= 0),
    (cell) => rewriteChildren(cell.text, cell.tokens, matcher),
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

const rewriteToken = (token: Token, matcher: LinkMatcher): string => {
  if (token.type === "link") {
    if (!linkMatches(matcher, token.href)) return token.raw;
    // `Token` is `MarkedToken | Tokens.Generic`; Generic has `tokens?`
    // optional and `type: string`, so narrowing on `type === "link"` still
    // leaves `tokens` as `Token[] | undefined`. The assert narrows it.
    assert(token.tokens, "Markdown link has no parsed text");
    return rewriteChildren(token.text, token.tokens, matcher);
  }
  if (isTableToken(token)) return rewriteTable(token, matcher);
  if (token.type === "list") {
    return rewriteChildren(token.raw, token.items, matcher);
  }
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return rewriteChildren(token.raw, token.tokens, matcher);
  }
  return token.raw;
};

const rewriteTokens = (
  tokens: readonly Token[],
  matcher: LinkMatcher,
): string => tokens.map((token) => rewriteToken(token, matcher)).join("");
