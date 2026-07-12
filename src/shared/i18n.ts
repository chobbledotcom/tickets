/**
 * Internationalization module using ICU MessageFormat
 *
 * Provides request-scoped locale detection and message formatting.
 * Uses AsyncLocalStorage to avoid threading locale through every function.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { IntlMessageFormat } from "intl-messageformat";
import { lazyRef } from "#fp";
import en from "#locales/en/index.ts";
import { getEnv } from "#shared/env.ts";

/** Message map: flat dot-namespaced keys → ICU message strings */
type Messages = Record<string, string>;

/** Registered locale message maps — English is built-in as the default fallback */
const locales: Record<string, Messages> = { en };

/**
 * A resolved message is either a plain string (needs no ICU processing at all)
 * or a compiled ICU format. Around 88% of our copy is plain, so keeping the two
 * apart lets the common key skip constructing — and later invoking — a formatter.
 */
type Resolved = string | IntlMessageFormat;

/** ICU parsing is non-trivial, so cache the resolved message by locale + key. */
const formatCache: Record<string, Resolved | null | undefined> = {};

/** Get the list of registered locale codes */
export const getRegisteredLocales = (): string[] => Object.keys(locales);

/** Drop every compiled formatter so the next lookups recompile. */
const clearFormatCache = (): void => {
  for (const key of Object.keys(formatCache)) delete formatCache[key];
};

/**
 * Merge additional messages into a locale at runtime. Used to load a large,
 * single-page bundle (the admin guide, ~120KB) on demand rather than in the
 * eager `en` merge, keeping its weight off the cold-boot path. The owning route
 * registers its bundle before rendering; a key still missing after that throws
 * in `t()` exactly as a typo would, so the fail-loud contract is preserved.
 *
 * `resolveMessage` caches a `null` for any key it can't resolve, so a lazy key looked
 * up before it is registered would otherwise stay poisoned for the isolate's
 * life. Clearing the format cache after merging lets the next lookup recompile
 * against the new copy instead of returning the stale miss. Registration happens
 * once per isolate (guide load), so recompiling on next use costs nothing real.
 */
export const registerMessages = (locale: string, extra: Messages): void => {
  locales[locale] = { ...locales[locale], ...extra };
  clearFormatCache();
};

// --- Operator-configurable copy replacements (I18N_REPLACEMENTS) ---

/** Rewrites the translatable copy of a message template. */
type Replacer = (template: string) => string;

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
 * Build a replacer from an `I18N_REPLACEMENTS` spec like `"foo|bar,baz|bee"`.
 *
 * It rewrites the *translatable copy* of a message: matching is case-insensitive
 * and by substring (`"foo|bar"` turns `"foobar"` into `"barbar"`), and the
 * output copies the source's capitalisation — only all-lowercase (`"foo"` →
 * `"bar"`) or title-case (`"Foo"` → `"Bar"`) occur in real copy, so the first
 * character decides which.
 *
 * It deliberately leaves three things alone: HTML tags/attributes (so link
 * hrefs survive), `<code>` examples (literal route/CLI text), and — because it
 * runs on the message template before ICU formatting (see `resolveMessage`) —
 * interpolated values such as a stored listing name. Avoid terms that collide
 * with ICU keywords/placeholder names (`name`, `count`, `plural`, …).
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
  return (template) =>
    template
      .split(PROTECTED_SPAN)
      .map((segment, i) => (i % 2 === 0 ? rebrandProse(segment) : segment))
      .join("");
};

/** Compiled replacer, built once from the env on first use (resettable in tests). */
const [getReplacer, setReplacer] = lazyRef<Replacer>(() =>
  buildReplacer(getEnv("I18N_REPLACEMENTS")),
);

/**
 * Test hook: drop the cached replacer and every compiled format so the next
 * render re-reads `I18N_REPLACEMENTS` from the environment.
 */
export const resetI18nForTest = (): void => {
  setReplacer(null);
  clearFormatCache();
};

/**
 * A message with neither a `{` (an ICU placeholder) nor a `'` (ICU quote
 * escaping, where `''` renders as a single `'` and a lone `'` before a syntax
 * char starts a literal region) is passed through ICU unchanged — its formatted
 * output is the string itself. So we can skip building an `IntlMessageFormat`
 * for it entirely. Every other syntax character (`}`, `#`, `|`) is already
 * literal outside a placeholder, so this test is exact, not a heuristic.
 */
const needsIcu = (msg: string): boolean =>
  msg.includes("{") || msg.includes("'");

const resolveMessage = (locale: string, key: string): Resolved | null => {
  const cacheKey = `${locale}\0${key}`;
  if (cacheKey in formatCache) return formatCache[cacheKey]!;

  const raw = locales[locale]?.[key] ?? locales.en?.[key];
  if (raw === undefined) {
    formatCache[cacheKey] = null;
    return null;
  }

  // Rebrand the copy once, here, so interpolated values stay untouched and the
  // compiled (and cached) format does no extra per-render work.
  const msg = getReplacer()(raw);

  // Plain copy is cached and returned as-is; only genuine ICU needs a formatter.
  // ignoreTag: treat <tags> in messages as literal text (locale values may
  // contain HTML rendered via <Raw>), not ICU rich-text tag syntax.
  const resolved: Resolved = needsIcu(msg)
    ? new IntlMessageFormat(msg, locale, undefined, { ignoreTag: true })
    : msg;
  formatCache[cacheKey] = resolved;
  return resolved;
};

/**
 * Translate a key with optional ICU MessageFormat parameters.
 *
 * A key absent from both the active locale and the `en` fallback is a
 * programming error — a typo or, more often, a dynamically built key
 * (`listing_defaults.field.${field}.label`) whose translation was never added,
 * which the static forward coverage scan can't catch. Rather than silently
 * render the raw key (an ugly string that ships to production unnoticed), throw
 * so a page render — in tests or in the browser — fails loudly and the missing
 * translation is fixed at its source.
 */
export const t = (key: string, values?: Record<string, unknown>): string => {
  const locale = getLocale();
  const resolved = resolveMessage(locale, key);
  if (resolved === null) {
    throw new Error(
      `Missing translation for key "${key}" (locale "${locale}")`,
    );
  }
  // Plain copy is already its final text; only ICU messages need formatting.
  return typeof resolved === "string"
    ? resolved
    : String(resolved.format(values));
};

// --- Request-scoped locale via AsyncLocalStorage ---

const localeStore = new AsyncLocalStorage<string>();

/** Run a function with a specific locale in scope */
export const runWithLocale = <T>(locale: string, fn: () => T): T =>
  localeStore.run(locale, fn);

/** Get the current request's locale (defaults to "en") */
export const getLocale = (): string => localeStore.getStore() ?? "en";

/**
 * Parse the Accept-Language header and return the best matching registered locale.
 * Falls back to "en" if no match is found.
 *
 * `registered` defaults to the live locale list; tests pass an explicit list so
 * the parsing/sorting can be exercised against a locale that is not also the
 * "en" fallback (otherwise every parse bug still lands on "en" and hides).
 */
export const parseAcceptLanguage = (
  header: string | null,
  registered: string[] = getRegisteredLocales(),
): string => {
  if (!header) return "en";

  // Parse "en-GB,en;q=0.9,de;q=0.8" into sorted [{lang, q}]
  const entries = header
    .split(",")
    .map((part) => {
      const [lang = "", ...rest] = part.trim().split(";");
      const qMatch = rest.join(";").match(/q\s*=\s*([\d.]+)/);
      return {
        lang: lang.trim().toLowerCase(),
        q: qMatch ? Number(qMatch[1]) : 1,
      };
    })
    .filter((e) => e.lang && e.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { lang } of entries) {
    // Exact match (e.g. "de")
    if (registered.includes(lang)) return lang;
    // Base language match (e.g. "en-GB" → "en")
    const base = lang.split("-")[0]!;
    if (registered.includes(base)) return base;
  }

  return "en";
};
