/**
 * Markdown rendering for user-authored content.
 *
 * Two layers of defence keep rendered output safe to inject as HTML:
 *  1. Raw HTML in the source is escaped (so `<script>` etc. become text).
 *  2. Link/image URLs are restricted to a safe scheme allowlist, so
 *     `javascript:`/`data:` URLs can't smuggle script execution past step 1.
 */

import { Lexer, Marked, type Token, type Tokens } from "marked";
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

const md = new Marked({
  renderer: {
    html({ raw }) {
      return escapeHtml(raw);
    },
  },
  walkTokens: (token) => {
    if (hasHref(token) && !isSafeUrl(token.href)) token.href = "";
  },
});

/** Render markdown to HTML (block-level: paragraphs, lists, etc.). Raw HTML is escaped and unsafe URLs are stripped. */
export const renderMarkdown = (text: string): string =>
  md.parse(text) as string;

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
