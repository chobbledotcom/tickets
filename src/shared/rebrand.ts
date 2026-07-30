/**
 * Operator-configurable copy replacements (`I18N_REPLACEMENTS`).
 *
 * This module is pure: it turns a replacement spec into a function that
 * rewrites the translatable copy of a message template. `#shared/i18n.ts`
 * wires it to the environment and the format cache.
 */

import {
  isLiteralElement,
  isPluralElement,
  isSelectElement,
  type MessageFormatElement,
  parse,
} from "@formatjs/icu-messageformat-parser";

/**
 * A message with neither a `{` (an ICU placeholder) nor a `'` (ICU quote
 * escaping, where `''` renders as a single `'` and a lone `'` before a syntax
 * char starts a literal region) is passed through ICU unchanged — its formatted
 * output is the string itself. So we can skip building an `IntlMessageFormat`
 * for it entirely. Every other syntax character (`}`, `#`, `|`) is already
 * literal outside a placeholder, so this test is exact, not a heuristic.
 */
export const needsIcu = (msg: string): boolean =>
  msg.includes("{") || msg.includes("'");

/**
 * Rewrites the translatable copy of a message template. An ICU template comes
 * back as a rebranded parse tree, which `IntlMessageFormat` accepts directly —
 * never re-printed to a string, so ICU escaping survives untouched.
 */
export type Replacer = (template: string) => string | MessageFormatElement[];

/** No replacements configured: hand the template straight back, zero overhead. */
const identity: Replacer = (template) => template;

/** Escape a literal for safe interpolation into a RegExp source. */
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Capitalise the first character; the caller guarantees `s` is non-empty. */
const titleCase = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

/**
 * Spans that must never be rewritten, captured whole so the rebrander only ever
 * sees the prose between them:
 *   - a complete `<code>…</code>` block (literal route/CLI examples), and
 *   - any single HTML tag `<…>` (keeping tag names and attributes such as
 *     link `href`s intact).
 * The capturing group makes `String.split` keep these spans, at odd indices.
 */
const PROTECTED_SPAN = /(<code\b[^>]*>[\s\S]*?<\/code>|<[^>]+>)/gi;

/**
 * Whether the copy at this point sits inside an open `<code>` example. The flag
 * is threaded through a whole template because an ICU argument can split one
 * `<code>…</code>` span across several literal nodes — the closing half must
 * stay as protected as the opening half.
 */
type CodeSpanState = { inCode: boolean };

/** A lone `<code …>` opener — its closing tag lives in a later segment. */
const CODE_OPENER = /^<code\b[^>]*>$/i;
/** The matching `</code>` closer arriving in a later segment. */
const CODE_CLOSER = /^<\/code>$/i;

/** Track a `<code>` opener or closer passing by; the span itself stays as-is. */
const trackCodeSpan = (span: string, state: CodeSpanState): string => {
  if (CODE_OPENER.test(span)) state.inCode = true;
  else if (CODE_CLOSER.test(span)) state.inCode = false;
  return span;
};

/**
 * Rebrand every literal copy node in an ICU template's parse tree, walking into
 * each plural/select branch. Argument names and keywords are other node kinds,
 * so they can never be rewritten.
 */
const rebrandIcuNodes = (
  nodes: MessageFormatElement[],
  rebrandCopy: (copy: string, state: CodeSpanState) => string,
  state: CodeSpanState,
): void => {
  for (const node of nodes) {
    if (isLiteralElement(node)) node.value = rebrandCopy(node.value, state);
    else if (isPluralElement(node) || isSelectElement(node))
      for (const branch of Object.values(node.options))
        rebrandIcuNodes(branch.value, rebrandCopy, state);
  }
};

/**
 * Build a replacer from an `I18N_REPLACEMENTS` spec like `"foo|bar,baz|bee"`.
 *
 * It rewrites the *translatable copy* of a message: matching is case-insensitive
 * and by substring (`"foo|bar"` turns `"foobar"` into `"barbar"`), and the
 * output copies the source's capitalisation — only all-lowercase (`"foo"` →
 * `"bar"`) or title-case (`"Foo"` → `"Bar"`) occur in real copy, so the first
 * character decides which.
 *
 * It deliberately leaves four things alone: HTML tags/attributes (so link
 * hrefs survive), `<code>` examples (literal route/CLI text), the ICU syntax
 * of a message — argument names, `plural`/`select` keywords and selectors —
 * because the handler supplies values under those exact names, and — since it
 * runs on the message template before ICU formatting (see `resolveMessage`) —
 * interpolated values such as a stored listing name. An ICU template is parsed
 * and only its literal copy rebranded, so `listing|event` still turns
 * `one {# listing}` into `one {# event}` without ever touching the
 * `{listings, plural, …}` argument that names it.
 *
 * Parsing and regex compilation happen once here, and `resolveMessage` compiles and
 * caches the rebranded template, so rendering stays a plain ICU format with no
 * extra per-call work — important on a cold-booting edge runtime.
 */
export const buildReplacer = (raw: string | undefined): Replacer => {
  if (!raw) return identity;

  const map = new Map<string, { lower: string; title: string }>();
  for (const pair of raw.split(",")) {
    const [from = "", to = ""] = pair.split("|");
    const search = from.trim().toLowerCase();
    const replace = to.trim().toLowerCase();
    // Skip blanks/malformed pairs; first definition of a term wins.
    if (!search || !replace || map.has(search)) continue;
    map.set(search, { lower: replace, title: titleCase(replace) });
  }
  if (map.size === 0) return identity;

  // Longest terms first so overlapping prefixes match maximally (e.g. a
  // configured "foobar" wins over "foo" on the input "foobar").
  const pattern = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const regex = new RegExp(pattern, "gi");

  const rebrandProse = (prose: string): string =>
    prose.replace(regex, (match) => {
      const entry = map.get(match.toLowerCase())!;
      const first = match[0]!;
      return first === first.toLowerCase() ? entry.lower : entry.title;
    });

  // Rewrite only the prose between protected spans, leaving tags/code verbatim.
  // A `<code>` opener whose closer sits in a later literal node flips the
  // state, so the copy in between stays protected too.
  const rebrandCopy = (copy: string, state: CodeSpanState): string =>
    copy
      .split(PROTECTED_SPAN)
      .map((segment, i) => {
        if (i % 2 === 1) return trackCodeSpan(segment, state);
        return state.inCode ? segment : rebrandProse(segment);
      })
      .join("");

  return (template) => {
    if (!needsIcu(template)) return rebrandCopy(template, { inCode: false });
    const nodes = parse(template, { ignoreTag: true });
    rebrandIcuNodes(nodes, rebrandCopy, { inCode: false });
    return nodes;
  };
};
