/**
 * Internationalization module using ICU MessageFormat
 *
 * Provides request-scoped locale detection and message formatting: the locale
 * rides the request scope instead of being threaded through every function.
 */

import { IntlMessageFormat } from "intl-messageformat";
import { lazyRef } from "#fp";
import {
  ENGLISH_MESSAGE_LOADERS,
  type MessageGroup,
  type Messages,
  SYSTEM_MESSAGES,
} from "#locales/manifest.ts";
import { getEnv } from "#shared/env.ts";
import { buildReplacer, needsIcu, type Replacer } from "#shared/rebrand.ts";
import { createScopedValue } from "#shared/request-scoped.ts";

const LOCALE_LOADERS = { en: ENGLISH_MESSAGE_LOADERS };

interface I18nState {
  readonly loaded: Set<MessageGroup>;
  readonly messages: Map<string, string>;
  readonly owners: Map<string, MessageGroup>;
  readonly pending: Map<MessageGroup, Promise<void>>;
}

const createI18nState = (): I18nState => ({
  loaded: new Set(["system"]),
  messages: new Map(Object.entries(SYSTEM_MESSAGES)),
  owners: new Map(
    Object.keys(SYSTEM_MESSAGES).map((key) => [key, "system"] as const),
  ),
  pending: new Map(),
});

const [getI18nState, setI18nState] = lazyRef(createI18nState);

/**
 * A resolved message is either a plain string (needs no ICU processing at all)
 * or a compiled ICU format. Around 88% of our copy is plain, so keeping the two
 * apart lets the common key skip constructing — and later invoking — a formatter.
 */
type Resolved = string | IntlMessageFormat;

/** ICU parsing is non-trivial, so cache the resolved message by locale + key. */
const formatCache: Record<string, Resolved | undefined> = {};

/** Get the list of registered locale codes */
export const getRegisteredLocales = (): string[] => Object.keys(LOCALE_LOADERS);

/** Drop every compiled formatter so the next lookups recompile. */
const clearFormatCache = (): void => {
  for (const key of Object.keys(formatCache)) delete formatCache[key];
};

/** Add one catalog to message and ownership maps, rejecting invalid overlap. */
export const addMessageGroup = (
  messages: Map<string, string>,
  owners: Map<string, MessageGroup>,
  group: MessageGroup,
  extra: Messages,
): void => {
  const entries = Object.entries(extra);
  for (const [key, message] of entries) {
    if (typeof message !== "string") {
      throw new TypeError(`en/${group} message "${key}" is not a string`);
    }
    const owner = owners.get(key);
    if (owner !== undefined && owner !== group) {
      throw new Error(
        `Message key "${key}" belongs to both en/${owner} and en/${group}`,
      );
    }
  }
  for (const [key, message] of entries) {
    messages.set(key, message);
    owners.set(key, group);
  }
};

const registerGroup = (
  state: I18nState,
  group: MessageGroup,
  extra: Messages,
): void => {
  addMessageGroup(state.messages, state.owners, group, extra);
  state.loaded.add(group);
};

const ensureMessageGroup = (
  state: I18nState,
  group: MessageGroup,
): Promise<void> => {
  if (state.loaded.has(group)) return Promise.resolve();
  const inFlight = state.pending.get(group);
  if (inFlight) return inFlight;

  const load = async (): Promise<void> => {
    try {
      registerGroup(state, group, await LOCALE_LOADERS.en[group]());
    } finally {
      state.pending.delete(group);
    }
  };
  const pending = load();
  state.pending.set(group, pending);
  return pending;
};

/** Load message groups before importing or invoking the route that uses them. */
export const ensureMessageGroups = async (
  groups: readonly MessageGroup[],
): Promise<void> => {
  const state = getI18nState();
  await Promise.all(groups.map((group) => ensureMessageGroup(state, group)));
};

const requestMessageGroups =
  createScopedValue<ReadonlySet<MessageGroup> | null>(() => null);

/** Load a route's copy, then make only those groups visible inside its work. */
export const withMessageGroups = async <T>(
  groups: readonly MessageGroup[],
  fn: () => T | Promise<T>,
): Promise<T> => {
  await ensureMessageGroups(groups);
  return await requestMessageGroups.run(new Set(["system", ...groups]), fn);
};

/** Compiled replacer, built once from the env on first use (resettable in tests). */
const [getReplacer, setReplacer] = lazyRef<Replacer>(() =>
  buildReplacer(getEnv("I18N_REPLACEMENTS")),
);

/**
 * Test hook: drop the cached replacer and every compiled format so the next
 * render re-reads `I18N_REPLACEMENTS` from the environment. Pass true when a
 * loader test also needs to return to the system-only startup state.
 */
export const resetI18nForTest = (resetMessages = false): void => {
  setReplacer(null);
  clearFormatCache();
  if (resetMessages) setI18nState(null);
};

const resolveMessage = (locale: string, key: string): Resolved | null => {
  const cacheKey = `${locale}\0${key}`;
  if (cacheKey in formatCache) return formatCache[cacheKey]!;

  const raw = getI18nState().messages.get(key);
  if (raw === undefined) return null;

  // Rebrand the copy once, here, so interpolated values stay untouched and the
  // compiled (and cached) format does no extra per-render work. A rebranded
  // ICU template arrives as a parse tree, which the formatter takes as-is.
  const msg = getReplacer()(raw);

  // Plain copy is cached and returned as-is; only genuine ICU needs a formatter.
  // ignoreTag: treat <tags> in messages as literal text (locale values may
  // contain HTML rendered via <Raw>), not ICU rich-text tag syntax.
  const resolved: Resolved =
    typeof msg !== "string" || needsIcu(msg)
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
  const owner = getI18nState().owners.get(key);
  const allowed = requestMessageGroups.read();
  const resolved =
    allowed !== null && owner !== undefined && !allowed.has(owner)
      ? null
      : resolveMessage(locale, key);
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

// --- Request-scoped locale ---

const requestLocale = createScopedValue(() => "en");

/** Run a function with a specific locale in scope */
export const runWithLocale = <T>(locale: string, fn: () => T): T =>
  requestLocale.run(locale, fn);

/** Get the current request's locale (defaults to "en") */
export const getLocale = (): string => requestLocale.read();

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
