/**
 * Per-request settings pre-load bundles (see settings-plan.md §4).
 *
 * The pre-routing pipeline reads settings before the lazy router resolves a
 * handler, so the load is keyed off the path *prefix* (pure, import-free).
 * `settingsForPath` always unions the prefix bundle with INFRA_SETTINGS, so
 * the declaration in `app/prefixes.ts` lists only the *extra* keys a route
 * reads beyond infra. The whole set is fetched in one `WHERE key IN (...)`
 * query.
 */

import { CONFIG_KEYS } from "#db/settings.ts";
import { ALL_SNAPSHOT_SETTINGS } from "./app/prefix-setting-keys.ts";
import { prefixSettings } from "./app/prefixes.ts";

/** Extract first path segment for O(1) prefix dispatch */
export const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};

/**
 * Keys every request needs regardless of route. Each entry below is here
 * because something unconditional reads it: domain resolution, routing gates,
 * the bare `Layout` every error page renders, the CSP rebuild, session auth and
 * PII decryption, and the listing-default resolution that runs at the cache
 * layer on any route that loads a listing.
 */
const INFRA_SETTINGS: readonly string[] = [
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.ENABLED_FEATURES,
  // The CSP rebuild reads the saved flag that says the custom CSS loads
  // Bunny's fonts. The flag is scanned when the CSS is saved (see
  // bunny-fonts.ts).
  CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.SETUP_COMPLETE,
  CONFIG_KEYS.SHOW_PUBLIC_API,
  CONFIG_KEYS.THEME,
  CONFIG_KEYS.UNDERLINE_LINKS,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  // The Layout renders the site footer on every page but admin's, so the key
  // rides with the other Layout-read settings.
  CONFIG_KEYS.SITE_FOOTER,
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.AUTO_PURGE_ORPHANS,
  CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
];

/** Settings to pre-load for a path: infra ∪ the prefix's bundle. An
 * unlisted prefix falls back to the full snapshot. */
export const settingsForPath = (path: string): readonly string[] => {
  const prefix = getPrefix(path);
  const bundle = Object.hasOwn(prefixSettings, prefix)
    ? prefixSettings[prefix]
    : undefined;
  return [...INFRA_SETTINGS, ...(bundle ?? ALL_SNAPSHOT_SETTINGS)];
};
