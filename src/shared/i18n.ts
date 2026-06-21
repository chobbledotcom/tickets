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

const getFormat = (locale: string, key: string): IntlMessageFormat | null => {
  const cacheKey = `${locale}\0${key}`;
  if (cacheKey in formatCache) return formatCache[cacheKey]!;

  const msg = locales[locale]?.[key] ?? locales.en?.[key];
  if (msg === undefined) {
    formatCache[cacheKey] = null;
    return null;
  }

  // ignoreTag: treat <tags> in messages as literal text (locale values may
  // contain HTML rendered via <Raw>), not ICU rich-text tag syntax.
  const fmt = new IntlMessageFormat(msg, locale, undefined, {
    ignoreTag: true,
  });
  formatCache[cacheKey] = fmt;
  return fmt;
};

// --- Operator-configurable text replacements (I18N_REPLACEMENTS) ---

/** Applies the configured substring replacements to a rendered value. */
type Replacer = (value: string) => string;

/** No replacements configured: hand the value straight back, zero overhead. */
const identity: Replacer = (value) => value;

/** Escape a literal for safe interpolation into a RegExp source. */
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Capitalise the first character; the caller guarantees `s` is non-empty. */
const titleCase = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

/**
 * Build a replacer from an `I18N_REPLACEMENTS` spec like `"foo|bar,baz|bee"`.
 *
 * Matching is case-insensitive and by substring — `"foo|bar"` turns `"foobar"`
 * into `"barbar"` — and the output copies the source's capitalisation. Real
 * copy is only ever all-lowercase (`"foo"` → `"bar"`) or title-case (`"Foo"` →
 * `"Bar"`), so the first character is enough to tell the two apart.
 *
 * All parsing and regex compilation happens once, here, so each render is a
 * single regex pass — this code runs on a cold-booting edge runtime where
 * per-render work matters.
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

  return (value) =>
    value.replace(regex, (match) => {
      const entry = map.get(match.toLowerCase())!;
      const first = match[0]!;
      return first === first.toLowerCase() ? entry.lower : entry.title;
    });
};

/** Compiled replacer, built once from the env on first use (resettable in tests). */
const [getReplacer, setI18nReplacerForTest] = lazyRef<Replacer>(() =>
  buildReplacer(getEnv("I18N_REPLACEMENTS")),
);

export { setI18nReplacerForTest };

/** Translate a key with optional ICU MessageFormat parameters */
export const t = (key: string, values?: Record<string, unknown>): string => {
  const locale = getLocale();
  const fmt = getFormat(locale, key);
  // Missing translation falls back to the key path itself — never run
  // replacements over that, only over genuinely rendered values.
  if (!fmt) return key;
  return getReplacer()(String(fmt.format(values)));
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
