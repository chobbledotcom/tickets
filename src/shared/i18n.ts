/**
 * Internationalization module using ICU MessageFormat
 *
 * Provides request-scoped locale detection and message formatting.
 * Uses AsyncLocalStorage to avoid threading locale through every function.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { IntlMessageFormat } from "intl-messageformat";
import en from "#locales/en/index.ts";

/** Message map: flat dot-namespaced keys → ICU message strings */
type Messages = Record<string, string>;

/** Registered locale message maps — English is built-in as the default fallback */
const locales: Record<string, Messages> = { en };

/** Register a locale's messages (called at startup) */
export const addLocale = (locale: string, messages: Messages): void => {
  locales[locale] = messages;
};

/** Get the list of registered locale codes */
export const getRegisteredLocales = (): string[] => Object.keys(locales);

// --- Compiled message cache ---
const cache = new Map<string, IntlMessageFormat>();

const getFormat = (locale: string, key: string): IntlMessageFormat | null => {
  const cacheKey = `${locale}:${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const msg = locales[locale]?.[key] ?? locales["en"]?.[key];
  if (msg === undefined) return null;

  const fmt = new IntlMessageFormat(msg, locale);
  cache.set(cacheKey, fmt);
  return fmt;
};

/** Translate a key with optional ICU MessageFormat parameters */
export const t = (key: string, values?: Record<string, unknown>): string => {
  const locale = getLocale();
  const fmt = getFormat(locale, key);
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
