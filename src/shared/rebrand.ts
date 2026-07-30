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
 * Where the scan through a message's copy currently is. It is threaded across
 * literal nodes because an ICU argument can split an HTML tag (`<a
 * href="/x/{id}">`) or a whole `<code>…</code>` example over several nodes —
 * the later halves must stay as protected as the first.
 */
type ScanState = {
  /** Inside a `<code>…</code>` example: everything is literal until it closes. */
  inCode: boolean;
  /** Inside an HTML tag whose `>` sits in a later node. */
  inTag: boolean;
  /** The unfinished tag is a `<code …>` opener, so closing it starts a code span. */
  tagIsCode: boolean;
};

const freshScan = (): ScanState => ({
  inCode: false,
  inTag: false,
  tagIsCode: false,
});

const CODE_CLOSE = "</code>";

/** Whether the text starting at an `<` opens a `<code>` example. */
const opensCode = (rest: string): boolean => /^<code\b/i.test(rest);

/** Rewrites a run of plain prose (no tags or code in it). */
type ProseRewriter = (prose: string) => string;

/** Copy code text verbatim up to (and including) its `</code>`; -1 = no close here. */
const takeCodeSpan = (copy: string, from: number): number =>
  copy.toLowerCase().indexOf(CODE_CLOSE, from);

/** One scanner move: the text to emit, and where to continue (-1 = at the end). */
type ScanStep = { text: string; next: number };

/** Inside a code example: emit it verbatim until (and including) `</code>`. */
const stepCode = (copy: string, i: number, state: ScanState): ScanStep => {
  const close = takeCodeSpan(copy, i);
  if (close === -1) return { next: -1, text: copy.slice(i) };
  state.inCode = false;
  return {
    next: close + CODE_CLOSE.length,
    text: copy.slice(i, close + CODE_CLOSE.length),
  };
};

/** Inside an unfinished tag: emit it verbatim until (and including) its `>`. */
const stepTag = (copy: string, i: number, state: ScanState): ScanStep => {
  const end = copy.indexOf(">", i);
  if (end === -1) return { next: -1, text: copy.slice(i) };
  state.inTag = false;
  state.inCode = state.tagIsCode;
  state.tagIsCode = false;
  return { next: end + 1, text: copy.slice(i, end + 1) };
};

/** In prose: rebrand up to the next tag, then emit that tag (or note it is unfinished). */
const stepProse = (
  copy: string,
  i: number,
  state: ScanState,
  rebrandProse: ProseRewriter,
): ScanStep => {
  const open = copy.indexOf("<", i);
  if (open === -1) return { next: -1, text: rebrandProse(copy.slice(i)) };
  const prose = rebrandProse(copy.slice(i, open));
  const end = copy.indexOf(">", open);
  if (end === -1) {
    state.inTag = true;
    state.tagIsCode = opensCode(copy.slice(open));
    return { next: -1, text: prose + copy.slice(open) };
  }
  state.inCode = opensCode(copy.slice(open));
  return { next: end + 1, text: prose + copy.slice(open, end + 1) };
};

/**
 * Rewrite one literal node's copy: prose is rebranded; HTML tags (with their
 * attributes) and `<code>` examples pass through verbatim, even when an ICU
 * argument split them across nodes.
 */
const rebrandLiteral = (
  copy: string,
  rebrandProse: ProseRewriter,
  state: ScanState,
): string => {
  let out = "";
  let i = 0;
  while (i !== -1 && i < copy.length) {
    const step = state.inCode
      ? stepCode(copy, i, state)
      : state.inTag
        ? stepTag(copy, i, state)
        : stepProse(copy, i, state, rebrandProse);
    out += step.text;
    i = step.next;
  }
  return out;
};

/**
 * The branches of one plural/select are alternatives for the same spot in the
 * message, so each starts from the same scan state; well-formed copy leaves
 * them all agreeing, and the first branch's exit state carries forward.
 */
const rebrandBranches = (
  options: Record<string, { value: MessageFormatElement[] }>,
  rebrandCopy: (copy: string, state: ScanState) => string,
  state: ScanState,
): void => {
  const entry = { ...state };
  let adopted = false;
  for (const branch of Object.values(options)) {
    const branchState = { ...entry };
    rebrandIcuNodes(branch.value, rebrandCopy, branchState);
    if (!adopted) Object.assign(state, branchState);
    adopted = true;
  }
};

/**
 * Rebrand every literal copy node in an ICU template's parse tree, walking into
 * each plural/select branch. Argument names and keywords are other node kinds,
 * so they can never be rewritten.
 */
const rebrandIcuNodes = (
  nodes: MessageFormatElement[],
  rebrandCopy: (copy: string, state: ScanState) => string,
  state: ScanState,
): void => {
  for (const node of nodes) {
    if (isLiteralElement(node)) node.value = rebrandCopy(node.value, state);
    else if (isPluralElement(node) || isSelectElement(node))
      rebrandBranches(node.options, rebrandCopy, state);
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

  const rebrandProse: ProseRewriter = (prose) =>
    prose.replace(regex, (match) => {
      const entry = map.get(match.toLowerCase())!;
      const first = match[0]!;
      return first === first.toLowerCase() ? entry.lower : entry.title;
    });

  const rebrandCopy = (copy: string, state: ScanState): string =>
    rebrandLiteral(copy, rebrandProse, state);

  return (template) => {
    if (!needsIcu(template)) return rebrandCopy(template, freshScan());
    const nodes = parse(template, { ignoreTag: true });
    rebrandIcuNodes(nodes, rebrandCopy, freshScan());
    return nodes;
  };
};
