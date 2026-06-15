/**
 * Markdown rendering for user-authored content.
 *
 * Two layers of defence keep rendered output safe to inject as HTML:
 *  1. Raw HTML in the source is escaped (so `<script>` etc. become text).
 *  2. Link/image URLs are restricted to a safe scheme allowlist, so
 *     `javascript:`/`data:` URLs can't smuggle script execution past step 1.
 */

import { Marked, type Token } from "marked";
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
    // CommonMark turns a backslash or two-plus trailing spaces before a newline
    // into a hard <br>. That lets stray trailing whitespace — from copy-paste,
    // an editor reflowing a long line, or word-wrap — force a line break in the
    // middle of a paragraph. Render every hard break as a plain space so authored
    // content always flows as continuous prose. Real paragraph breaks (a blank
    // line), lists, and headings are unaffected; code blocks never emit br.
    br() {
      return " ";
    },
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
