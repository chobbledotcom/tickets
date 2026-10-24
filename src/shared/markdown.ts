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
import { escapeHtml } from "#jsx/escape-html.ts";
import { getPageImageUrls } from "#shared/request-context.ts";

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

/** The per-render token walk. A short-form image reference (`![alt](img#7)`)
 * written by the editor's image dropdown resolves to the image's uid URL in
 * the render's table. The table is the request's page-image slot, or the
 * call site's override. An id the table lacks renders nothing to load, so
 * the <img> falls back to its alt text. Links and code spans never carry
 * the rewrite. Unsafe URLs strip to nothing. */
const walkTokensFor =
  (imageUrls: ReadonlyMap<number, string>) =>
  (token: Token): void => {
    if (token.type === "image" && typeof token.href === "string") {
      const id = token.href.match(/^img#(\d+)$/)?.[1];
      if (id) token.href = imageUrls.get(Number(id)) ?? "";
    }
    if (hasHref(token) && !isSafeUrl(token.href)) token.href = "";
  };

/** Built on first render, not at module load — `new Marked(...)` compiles
 * marked's tokenizer regexes, so deferring it keeps that work off the cold boot
 * of requests that never render markdown. `once` returns synchronously, so the
 * synchronous render callers are unaffected. The token walk is per call, so
 * each render carries its own image-url table. */
const md = once(
  () =>
    new Marked({
      renderer: {
        html({ raw }) {
          return escapeHtml(raw);
        },
      },
    }),
);

/** Renders block markdown, escaping raw HTML and stripping unsafe URLs. An
 * `img#N` reference resolves through `imageUrls`. Without the argument, it
 * resolves through the request's page-image slot, which the page's loaders
 * fill with `addPageImageUrls` (see `#db/images.ts`). A missing entry
 * renders no image, and the alt text shows. The override exists for a render
 * whose table is not the page's, such as the site footer. */
export const renderMarkdown = (
  text: string,
  imageUrls: ReadonlyMap<number, string> = getPageImageUrls(),
): string =>
  md().parse(text, { walkTokens: walkTokensFor(imageUrls) }) as string;

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

/** What one rewrite pass does to the tokens it meets: it rewrites the leaf
 * kinds it names and walks every other token for children. */
type TokenRewrites = {
  /** Demote a link to its plain text when its target matches. */
  link?: LinkMatcher;
  /** Replace a picture's address. undefined keeps the address as written. */
  image?: ImageDestination;
};

/** The address one picture reference resolves to, or undefined to keep the
 * address the author wrote. */
type ImageDestination = (href: string) => string | undefined;

/** True when `href` should be demoted to plain text. A string matcher is a
 * prefix check; a function matcher is called directly. */
const linkMatches = (matcher: LinkMatcher, href: string): boolean =>
  typeof matcher === "string" ? href.startsWith(matcher) : matcher(href);

/** Runs one rewrite pass over the whole lexed source. */
const rewriteLexedSource = (
  markdown: string,
  rewrites: TokenRewrites,
): string => rewriteTokens(Lexer.lex(markdown), rewrites);

/** Replace each markdown link whose target matches `matcher` with its plain
 * text. Used to strip links the viewer isn't allowed to open (e.g. owner-only
 * admin pages) before rendering — a rendered link is a promise that it works,
 * so a viewer who can't follow it gets the words without the link. */
export const withoutLinksTo = (
  markdown: string,
  matcher: LinkMatcher,
): string => rewriteLexedSource(markdown, { link: matcher });

/** Rewrites each picture reference's address through `toUrl`, and keeps
 * every other byte of the source. The lexer parses code spans and fenced
 * code blocks as code, not as pictures. A reference inside them keeps the
 * form the author wrote, the way the HTML render shows it. A reference
 * whose address `toUrl` leaves undefined keeps its written form too. */
export const rewriteImageDestinations = (
  markdown: string,
  toUrl: ImageDestination,
): string => rewriteLexedSource(markdown, { image: toUrl });

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
  rewrites: TokenRewrites,
  flattenMissing = true,
): string => {
  const parts = locateSourceParts(raw, children, (child) => child.raw);
  if (flattenMissing && parts.some(({ index }) => index < 0)) {
    return rewriteChildren(raw, children.flatMap(leafTokens), rewrites, false);
  }
  return rewriteSourceParts(
    raw,
    parts.filter(({ index }) => index >= 0),
    (child) => rewriteToken(child, rewrites),
  );
};

const rewriteTable = (token: Tokens.Table, rewrites: TokenRewrites): string => {
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
    (cell) => rewriteChildren(cell.text, cell.tokens, rewrites),
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

/** The source of one inline picture, read the way marked reads it: the
 * written alt text, `](`, the address, and the optional title part. The alt
 * and title spellings are marked's own inline rules. A quoted title can hold
 * a closing parenthesis, so the match runs to the source's end instead of
 * the first one. */
const IMAGE_SOURCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character range is marked's own bare-address rule, which ends a bare address at the characters a URL never holds
  /^!\[((?:\[(?:\\[\s\S]|[^[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^[\]\\`])*)\]\((\s*)((?:<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(?:"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)))?\s*\)$/;

/** The address marked reads from an address as written: trimmed, angle
 * brackets off, backslash escapes on punctuation undone. The token's `href`
 * holds the result. */
const markedHref = (dest: string): string => {
  const trimmed = dest.trim();
  const bare = trimmed.startsWith("<") ? trimmed.slice(1, -1) : trimmed;
  return bare.replace(/\\([\p{P}\p{S}])/gu, "$1");
};

/** Replaces one picture's address inside the token's own source, and keeps
 * every other byte of that source, the title part included. A source that
 * does not end in the address's parentheses, such as a `![alt][label]`
 * reference, keeps its written form. */
const rewriteImageSource = (
  raw: string,
  href: string,
  toUrl: ImageDestination,
): string => {
  const url = toUrl(href);
  if (url === undefined) return raw;
  const source = IMAGE_SOURCE.exec(raw);
  if (!source) return raw;
  const [, label, gap, dest] = source;
  // The three groups always join the match, and the address must read back
  // as the token's own address. A miss means this copy of marked's picture
  // rule drifted from marked itself.
  assert(
    label !== undefined &&
      gap !== undefined &&
      dest !== undefined &&
      markedHref(dest) === href,
    "The picture source match lost the token's address",
  );
  // `![` and `](` hold four characters around the label and the whitespace.
  const start = 4 + label.length + gap.length;
  return `${raw.slice(0, start)}${url}${raw.slice(start + dest.length)}`;
};

const rewriteToken = (token: Token, rewrites: TokenRewrites): string => {
  if (token.type === "link") {
    // `Token` is `MarkedToken | Tokens.Generic`; Generic has `tokens?`
    // optional and `type: string`, so narrowing on `type === "link"` still
    // leaves `tokens` as `Token[] | undefined`. The assert narrows it.
    assert(token.tokens, "Markdown link has no parsed text");
    if (rewrites.link !== undefined && linkMatches(rewrites.link, token.href)) {
      return rewriteChildren(token.text, token.tokens, rewrites);
    }
    // A kept link still passes its inner tokens on, so a picture inside the
    // link's text resolves.
    return rewriteChildren(token.raw, token.tokens, rewrites);
  }
  if (
    token.type === "image" &&
    typeof token.href === "string" &&
    rewrites.image
  ) {
    return rewriteImageSource(token.raw, token.href, rewrites.image);
  }
  if (isTableToken(token)) return rewriteTable(token, rewrites);
  if (token.type === "list") {
    return rewriteChildren(token.raw, token.items, rewrites);
  }
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return rewriteChildren(token.raw, token.tokens, rewrites);
  }
  return token.raw;
};

const rewriteTokens = (
  tokens: readonly Token[],
  rewrites: TokenRewrites,
): string => tokens.map((token) => rewriteToken(token, rewrites)).join("");
