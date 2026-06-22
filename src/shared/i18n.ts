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

/** ICU parsing is non-trivial, so cache compiled formats by locale + key. */
const formatCache: Record<string, IntlMessageFormat | null | undefined> = {};

/** Get the list of registered locale codes */
export const getRegisteredLocales = (): string[] => Object.keys(locales);

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
 * runs on the message template before ICU formatting (see `getFormat`) —
 * interpolated values such as a stored listing name. Avoid terms that collide
 * with ICU keywords/placeholder names (`name`, `count`, `plural`, …).
 *
 * Parsing and regex compilation happen once here, and `getFormat` compiles and
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
  for (const key of Object.keys(formatCache)) delete formatCache[key];
};

const getFormat = (locale: string, key: string): IntlMessageFormat | null => {
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

  // ignoreTag: treat <tags> in messages as literal text (locale values may
  // contain HTML rendered via <Raw>), not ICU rich-text tag syntax.
  const fmt = new IntlMessageFormat(msg, locale, undefined, {
    ignoreTag: true,
  });
  formatCache[cacheKey] = fmt;
  return fmt;
};

/** Translate a key with optional ICU MessageFormat parameters */
export const t = (key: string, values?: Record<string, unknown>): string => {
  const locale = getLocale();
  const fmt = getFormat(locale, key);
  // Missing translation falls back to the key itself.
  if (!fmt) return key;
  return String(fmt.format(values));
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
 */
export const parseAcceptLanguage = (header: string | null): string => {
  if (!header) return "en";

  const registered = getRegisteredLocales();

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
